import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from 'react';

/** A very small history-API router for the dashboard, mounted under `/ui`. */

export const BASE = '/ui';

interface RouteState {
  /** The path inside the dashboard, e.g. `/jobs/abc`. Always starts with `/`. */
  path: string;
  query: URLSearchParams;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouteState | null>(null);

const read = () => {
  const { pathname, search } = window.location;
  const inner = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  return { path: inner.replace(/\/+$/, '') || '/', search };
};

export function Router({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const navigate = useCallback((to: string, opts: { replace?: boolean } = {}) => {
    const url = to.startsWith('/') ? `${BASE}${to === '/' ? '' : to}` : to;
    if (opts.replace) window.history.replaceState({}, '', url);
    else window.history.pushState({}, '', url);
    setLoc(read());
  }, []);
  const value = useMemo(
    () => ({ path: loc.path, query: new URLSearchParams(loc.search), navigate }),
    [loc.path, loc.search, navigate],
  );
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRoute(): RouteState {
  const r = useContext(RouterContext);
  if (!r) throw new Error('useRoute needs a <Router>');
  return r;
}

export function Link({
  to,
  children,
  ...rest
}: { to: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const { navigate } = useRoute();
  return (
    <a
      {...rest}
      href={`${BASE}${to === '/' ? '' : to}`}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
        rest.onClick?.(e);
      }}
    >
      {children}
    </a>
  );
}
