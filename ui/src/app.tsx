import { useEffect, useState, type ReactNode } from 'react';
import { ConfirmProvider, Loading, ToastProvider } from './components';
import { PROJECT_STATUS_LABELS } from './format';
import { Link, Router, useRoute } from './router';
import { Sidebar, type NavItem } from './sidebar';
import { StreamProvider, useStream, useStreamEvent, type SourceFactory } from './stream';
import { useReloadOn } from './hooks';
import { ProjectProvider, useProject, useScopedApi } from './project';
import { ReauthProvider } from './reauth';
import type { ProposalCounts, ReviewCounts, SessionInfo } from './types';
import { AccountPage } from './pages/account';
import { BudgetsPage } from './pages/budgets';
import { ClientsPage } from './pages/clients';
import { ErrorsPage } from './pages/errors';
import { JobsPage } from './pages/jobs';
import { JournalPage } from './pages/journal';
import { ToolCallsPage } from './pages/toolcalls';
import { MaintenancePage } from './pages/maintenance';
import { MappingsPage } from './pages/mappings';
import { OverviewPage } from './pages/overview';
import { ProjectsPage } from './pages/projects';
import { ProposalsPage } from './pages/proposals';
import { ReviewPage } from './pages/review';
import { SettingsPage } from './pages/settings';
import { StagingPage } from './pages/staging';
import { AuditsPage } from './pages/audits';
import { AppraisalPage } from './pages/appraisal';
import { SnapshotsPage } from './pages/snapshots';
import { OffsitePage } from './pages/offsite';
import { AssetsPage } from './pages/assets';
import { TreePage } from './pages/tree';
import { LifecyclePage } from './pages/lifecycle';
import { ChronologyPage } from './pages/chronology';
import { WritersPage } from './pages/writers';
import { PacksPage } from './pages/packs';
import { TaggingPage } from './pages/tagging';
import { AutomationPage } from './pages/automation';
import { WorkstreamsPage } from './pages/workstreams';
import { EvaluationPanel } from './pages/evaluation';

type Theme = 'system' | 'light' | 'dark';

/**
 * Signs out through the sign-in module's own endpoint. A plain form POST would carry `Origin: null` (the dashboard is
 * served with `Referrer-Policy: no-referrer`), which that endpoint rightly refuses; a fetch() sends the real Origin.
 */
async function signOut(session: SessionInfo): Promise<void> {
  try {
    await fetch(session.logoutPath, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf_token: session.logoutCsrfToken }).toString(),
    });
  } finally {
    window.location.assign('/ui');
  }
}

/**
 * Always at the top of the sidebar, in this order (v3 F3c). Proposals carries the pending count; Review (v3 F3.4, ADR
 * 0055) the count of agents' direct writes not reviewed yet.
 */
export const TOP_NAV: NavItem[] = [
  { to: '/', label: 'Overview' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/proposals', label: 'Proposals' },
  { to: '/review', label: 'Review' },
];

/**
 * Every other page, filed under its group. The sidebar sorts groups by name and pages by label, so the order here does
 * not matter: a new page only needs its group named.
 */
export const NAV: NavItem[] = [
  { to: '/account', label: 'Account', group: 'Access & Account' },
  { to: '/clients', label: 'Clients & Access', group: 'Access & Account' },
  { to: '/assets', label: 'Asset Tree', group: 'Assets' },
  { to: '/staging', label: 'Staging', group: 'Assets' },
  { to: '/offsite', label: 'Off-site copy', group: 'Backups & Recovery' },
  { to: '/snapshots', label: 'Snapshots', group: 'Backups & Recovery' },
  { to: '/writers', label: 'Concurrent Writers', group: 'Limits' },
  { to: '/budgets', label: 'Request Budgets', group: 'Limits' },
  { to: '/errors', label: 'Errors', group: 'Monitoring' },
  { to: '/journal', label: 'Journal', group: 'Monitoring' },
  { to: '/tool-calls', label: 'Tool calls', group: 'Monitoring' },
  { to: '/workstreams', label: 'Workstreams', group: 'Monitoring' },
  { to: '/appraisal', label: 'Appraisal', group: 'Quality' },
  { to: '/audits', label: 'Audits', group: 'Quality' },
  { to: '/automation', label: 'Automation', group: 'Quality' },
  { to: '/evaluation', label: 'Evaluation', group: 'Quality' },
  { to: '/lifecycle', label: 'Archive and lifecycle', group: 'Repository' },
  { to: '/chronology', label: 'Chronology', group: 'Repository' },
  { to: '/tree', label: 'Repository Tree', group: 'Repository' },
  { to: '/tagging', label: 'Tagging', group: 'Repository' },
  { to: '/maintenance', label: 'Maintenance Jobs', group: 'Setup' },
  { to: '/packs', label: 'Packs', group: 'Setup' },
  { to: '/projects', label: 'Projects', group: 'Setup' },
  { to: '/mappings', label: 'Repository Mappings', group: 'Setup' },
  { to: '/settings', label: 'Settings', group: 'Setup' },
];

/**
 * Page modules with no sidebar entry of their own, on purpose: each is reached from its parent page. A test fails when a
 * page module is neither routed from here nor listed below.
 */
export const SUB_PAGES: { module: string; parent: string }[] = [
  { module: 'evaluation-run', parent: '/evaluation' },
  { module: 'evaluation-compare', parent: '/evaluation' },
  { module: 'evaluation-shared', parent: '/evaluation' },
  { module: 'chronology-ties', parent: '/chronology' },
  // v3 F4b (ADR 0064): "Pick the right value" on a consistency finding of the Audits page.
  { module: 'consistency-pick', parent: '/audits' },
  { module: 'registry', parent: '/mappings' },
  // v3 F7 (ADR 0070, G3): the Outfits panel of the Asset Tree page.
  { module: 'outfits', parent: '/assets' },
  // v3 F7c (ADR 0075, Z6): the Image archives card of the Asset Tree page.
  { module: 'archives', parent: '/assets' },
];

/** The router's table: a path, whether its sub-paths (`/jobs/abc`) are served too, and the page. */
export const ROUTES: { path: string; prefix?: boolean; render: (session: SessionInfo) => ReactNode }[] = [
  { path: '/', render: () => <OverviewPage /> },
  { path: '/jobs', prefix: true, render: () => <JobsPage /> },
  { path: '/errors', render: () => <ErrorsPage /> },
  { path: '/budgets', render: () => <BudgetsPage /> },
  { path: '/writers', render: () => <WritersPage /> },
  { path: '/proposals', render: () => <ProposalsPage /> },
  { path: '/review', render: () => <ReviewPage /> },
  { path: '/clients', render: (session) => <ClientsPage session={session} /> },
  { path: '/journal', render: () => <JournalPage /> },
  { path: '/packs', render: () => <PacksPage /> },
  { path: '/tool-calls', render: () => <ToolCallsPage /> },
  { path: '/evaluation', render: () => <EvaluationPage /> },
  { path: '/projects', render: () => <ProjectsPage /> },
  { path: '/tree', render: () => <TreePage /> },
  { path: '/lifecycle', render: () => <LifecyclePage /> },
  { path: '/chronology', render: () => <ChronologyPage /> },
  { path: '/assets', render: () => <AssetsPage /> },
  { path: '/staging', render: () => <StagingPage /> },
  { path: '/snapshots', render: () => <SnapshotsPage /> },
  { path: '/audits', render: () => <AuditsPage /> },
  { path: '/appraisal', render: () => <AppraisalPage /> },
  { path: '/tagging', render: () => <TaggingPage /> },
  { path: '/automation', render: () => <AutomationPage /> },
  { path: '/workstreams', render: () => <WorkstreamsPage /> },
  { path: '/offsite', render: () => <OffsitePage /> },
  { path: '/settings', render: () => <SettingsPage /> },
  { path: '/account', render: () => <AccountPage /> },
  { path: '/maintenance', render: () => <MaintenancePage /> },
  { path: '/mappings', prefix: true, render: () => <MappingsPage /> },
];

/** The Evaluation helper on a page of its own (it is also a panel on Tool calls), open from the start. */
function EvaluationPage() {
  return (
    <>
      <h1>Evaluation</h1>
      <EvaluationPanel defaultOpen />
    </>
  );
}

const readTheme = (): Theme => {
  try {
    const t = window.localStorage.getItem('lkb-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
};

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', theme);
    try {
      if (theme === 'system') window.localStorage.removeItem('lkb-theme');
      else window.localStorage.setItem('lkb-theme', theme);
    } catch {
      // Storage may be blocked: the theme just does not persist.
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'))];
}

function Routes({ session }: { session: SessionInfo }) {
  const { path } = useRoute();
  const route = ROUTES.find((r) => path === r.path || (r.prefix === true && path.startsWith(`${r.path}/`)));
  if (route) return <>{route.render(session)}</>;
  return (
    <>
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to the overview</Link>
      </p>
    </>
  );
}

/**
 * The project switcher (v2 A1): which project the scoped pages show. Projects without a proven LegendKeeper id have no
 * data yet, so they cannot be chosen. Other projects' pending proposals are listed under it.
 */
function ProjectSwitcher({ counts }: { counts: ProposalCounts | undefined }) {
  const { projects, selected, current, select, error, ready } = useProject();
  if (!ready) return null;
  if (projects.length === 0) {
    return (
      <div className="project-switch">
        <p className="muted small-text">
          {error ? 'The project list could not be loaded: showing the default project.' : 'No projects.'}
        </p>
      </div>
    );
  }
  const elsewhere = Object.entries(counts?.byProject ?? {}).filter(([name, n]) => name !== selected && n > 0);
  return (
    <div className="project-switch">
      <label htmlFor="project-select">Project</label>
      <select id="project-select" value={selected ?? ''} onChange={(e) => select(e.target.value)}>
        {projects.map((p) => (
          <option key={p.name} value={p.name} disabled={p.id === null && p.name !== selected}>
            {`${p.name}${p.isDefault ? ' (default)' : ''}${p.status !== 'active' ? ` · ${PROJECT_STATUS_LABELS[p.status] ?? p.status}` : ''}`}
          </option>
        ))}
      </select>
      {current && current.status !== 'active' && (
        <p className="project-warn small-text">
          This project is {PROJECT_STATUS_LABELS[current.status] ?? current.status}
          {current.reason ? `: ${current.reason}` : '.'}
        </p>
      )}
      {current?.readOnly && <p className="muted small-text">Read-only: writes to it are refused.</p>}
      {elsewhere.length > 0 && (
        <p className="muted small-text" data-testid="pending-elsewhere">
          Pending proposals elsewhere: {elsewhere.map(([name, n]) => `${name} ${n}`).join(', ')}
        </p>
      )}
    </div>
  );
}

function Shell({ session }: { session: SessionInfo }) {
  const { path } = useRoute();
  const { status } = useStream();
  const [theme, cycleTheme] = useTheme();
  const { ready, selected } = useProject();
  // The badge counts the selected project's pending proposals; `byProject` holds every project's.
  const counts = useScopedApi<ProposalCounts>('/proposals/counts');
  useReloadOn(['proposal', 'project'], counts.reload, 500);
  const pending = counts.data?.counts.pending ?? 0;
  // v3 F3.4 (ADR 0055): direct writes waiting for the owner's review; a job's end or a review changes it.
  const review = useScopedApi<ReviewCounts>('/review/counts');
  useReloadOn(['job', 'policy', 'project'], review.reload, 800);
  const unreviewed = review.data?.unreviewed ?? 0;
  const [, setTick] = useState(0);
  useStreamEvent('unauthenticated', () => setTick((n) => n + 1));
  const live = {
    live: 'Live',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    ended: 'Signed out',
  }[status];

  return (
    <div className="shell">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          LK-Bridge
          <small>Owner dashboard · v{session.version}</small>
        </div>
        <ProjectSwitcher counts={counts.data} />
        <Sidebar
          top={TOP_NAV}
          items={NAV}
          path={path}
          badges={{ '/proposals': pending, '/review': unreviewed }}
          badgeWords={{ '/review': 'unreviewed' }}
        />
        <div className="sidebar-foot">
          <span className="live" role="status" aria-label={`Live updates: ${live}`}>
            <span className={`dot dot-${status}`} aria-hidden="true" /> {live}
          </span>
          <button
            type="button"
            className="small"
            onClick={cycleTheme}
            aria-label={`Theme: ${theme}. Change theme`}
          >
            Theme: {theme}
          </button>
          <button type="button" className="small" onClick={() => void signOut(session)}>
            Sign out ({session.username})
          </button>
        </div>
      </aside>
      <main id="content">
        {/* Scoped pages wait for the project list; a new project remounts the page, so nothing of the last one stays. */}
        {ready ? <Routes key={selected ?? ''} session={session} /> : <Loading />}
      </main>
    </div>
  );
}

export function App({ session, createSource }: { session: SessionInfo; createSource?: SourceFactory }) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Router>
          <StreamProvider {...(createSource ? { createSource } : {})}>
            <ProjectProvider>
              <ReauthProvider totp={session.totpEnabled === true}>
                <Shell session={session} />
              </ReauthProvider>
            </ProjectProvider>
          </StreamProvider>
        </Router>
      </ConfirmProvider>
    </ToastProvider>
  );
}
