import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, apiConfig } from './api';
import { App } from './app';
import type { SessionInfo } from './types';
import './styles.css';

/** Loads the owner session first (it carries the CSRF token), then mounts the app. A 401 sends the page to sign-in. */
async function boot(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) return;
  try {
    const session = await api.get<SessionInfo>('/session');
    apiConfig.csrfToken = session.csrfToken;
    createRoot(root).render(
      <StrictMode>
        <App session={session} />
      </StrictMode>,
    );
  } catch (e) {
    // Unauthenticated: `api` has already started the redirect. Anything else: say so plainly.
    if ((e as { status?: number }).status !== 401) {
      root.textContent = 'The dashboard could not reach the bridge. Reload the page to try again.';
    }
  }
}

void boot();
