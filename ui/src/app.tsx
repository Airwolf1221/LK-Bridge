import { useEffect, useState } from 'react';
import { ConfirmProvider, Loading, ToastProvider } from './components';
import { PROJECT_STATUS_LABELS } from './format';
import { Link, Router, useRoute } from './router';
import { StreamProvider, useStream, useStreamEvent, type SourceFactory } from './stream';
import { useReloadOn } from './hooks';
import { ProjectProvider, useProject, useScopedApi } from './project';
import { ReauthProvider } from './reauth';
import type { ProposalCounts, SessionInfo } from './types';
import { AccountPage } from './pages/account';
import { BudgetsPage } from './pages/budgets';
import { ClientsPage } from './pages/clients';
import { ErrorsPage } from './pages/errors';
import { JobsPage } from './pages/jobs';
import { JournalPage } from './pages/journal';
import { MaintenancePage } from './pages/maintenance';
import { MappingsPage } from './pages/mappings';
import { OverviewPage } from './pages/overview';
import { ProjectsPage } from './pages/projects';
import { ProposalsPage } from './pages/proposals';
import { SettingsPage } from './pages/settings';
import { AssetsPage } from './pages/assets';
import { TreePage } from './pages/tree';
import { WritersPage } from './pages/writers';

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

const NAV: { to: string; label: string; later?: boolean }[] = [
  { to: '/', label: 'Overview' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/errors', label: 'Errors' },
  { to: '/budgets', label: 'Request Budgets' },
  { to: '/writers', label: 'Concurrent Writers' },
  { to: '/proposals', label: 'Proposals' },
  { to: '/clients', label: 'Clients & Access' },
  { to: '/journal', label: 'Journal' },
  { to: '/projects', label: 'Projects' },
  { to: '/tree', label: 'Repository Tree' },
  { to: '/assets', label: 'Asset Tree' },
  { to: '/settings', label: 'Settings' },
  { to: '/account', label: 'Account' },
  { to: '/maintenance', label: 'Maintenance Jobs' },
  { to: '/mappings', label: 'Repository Mappings' },
];

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
  if (path === '/') return <OverviewPage />;
  if (path === '/jobs' || path.startsWith('/jobs/')) return <JobsPage />;
  if (path === '/errors') return <ErrorsPage />;
  if (path === '/budgets') return <BudgetsPage />;
  if (path === '/writers') return <WritersPage />;
  if (path === '/proposals') return <ProposalsPage />;
  if (path === '/clients') return <ClientsPage session={session} />;
  if (path === '/journal') return <JournalPage />;
  if (path === '/projects') return <ProjectsPage />;
  if (path === '/tree') return <TreePage />;
  if (path === '/assets') return <AssetsPage />;
  if (path === '/settings') return <SettingsPage />;
  if (path === '/account') return <AccountPage />;
  if (path === '/maintenance') return <MaintenancePage />;
  if (path === '/mappings' || path.startsWith('/mappings/')) return <MappingsPage />;
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
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => {
            const current = n.to === '/' ? path === '/' : path === n.to || path.startsWith(`${n.to}/`);
            return (
              <Link key={n.to} to={n.to} {...(current ? { 'aria-current': 'page' as const } : {})}>
                <span>{n.label}</span>
                {n.to === '/proposals' && pending > 0 && (
                  <span className="count" aria-label={`${pending} pending`}>
                    {pending}
                  </span>
                )}
                {n.later && <span className="later">later</span>}
              </Link>
            );
          })}
        </nav>
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
