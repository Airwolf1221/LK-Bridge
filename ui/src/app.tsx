import { useEffect, useState } from 'react';
import { ConfirmProvider, ToastProvider } from './components';
import { Link, Router, useRoute } from './router';
import { StreamProvider, useStream, useStreamEvent, type SourceFactory } from './stream';
import { useApi, useReloadOn } from './hooks';
import type { SessionInfo } from './types';
import { BudgetsPage } from './pages/budgets';
import { ClientsPage } from './pages/clients';
import { ErrorsPage } from './pages/errors';
import { JobsPage } from './pages/jobs';
import { JournalPage } from './pages/journal';
import { OverviewPage } from './pages/overview';
import { Placeholder } from './pages/placeholder';
import { ProposalsPage } from './pages/proposals';
import { SettingsPage } from './pages/settings';
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
  { to: '/settings', label: 'Settings' },
  { to: '/maintenance', label: 'Maintenance Jobs', later: true },
  { to: '/mappings', label: 'Repository Mappings', later: true },
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
  if (path === '/settings') return <SettingsPage />;
  if (path === '/maintenance') return <Placeholder title="Maintenance Jobs" />;
  if (path === '/mappings') return <Placeholder title="Repository Mappings" />;
  return (
    <>
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to the overview</Link>
      </p>
    </>
  );
}

function Shell({ session }: { session: SessionInfo }) {
  const { path } = useRoute();
  const { status } = useStream();
  const [theme, cycleTheme] = useTheme();
  const counts = useApi<{ counts: Record<string, number> }>('/proposals/counts');
  useReloadOn(['proposal'], counts.reload, 500);
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
        <Routes session={session} />
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
            <Shell session={session} />
          </StreamProvider>
        </Router>
      </ConfirmProvider>
    </ToastProvider>
  );
}
