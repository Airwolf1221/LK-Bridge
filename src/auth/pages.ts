import { SCOPE_DESCRIPTIONS } from './scopes.js';

/** Server-rendered pages for login, consent and errors. All dynamic text is HTML-escaped. */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#5d5b55;--line:#dedbd3;
--accent:#2f5d50;--warn-bg:#fff4dc;--warn-ink:#6b4a00;--err:#9b1c1c}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#21201d;--ink:#eeece6;--muted:#a9a69d;
--line:#3a3934;--accent:#7fc1ad;--warn-bg:#3a2f12;--warn-ink:#f3d58a;--err:#f19a9a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;margin:2.5rem auto;padding:0 1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.5rem}
h1{font-size:1.35rem;margin:0 0 1rem}p{margin:.5rem 0}.muted{color:var(--muted);font-size:.9rem}
.host{font-size:1.6rem;font-weight:700;word-break:break-all;margin:.25rem 0}
.box{border:1px solid var(--line);border-radius:8px;padding:.75rem 1rem;margin:1rem 0}
.warn{background:var(--warn-bg);color:var(--warn-ink);border-color:transparent}
.err{color:var(--err)}ul{padding-left:1.2rem}code{word-break:break-all}
label{display:block;margin:.75rem 0 .25rem;font-weight:600}
input{width:100%;padding:.6rem;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;font:inherit}
.actions{display:flex;gap:.75rem;margin-top:1.25rem;flex-wrap:wrap}
button{font:inherit;padding:.6rem 1.2rem;border-radius:6px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--card)}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · LK-Bridge</title><style>${STYLE}</style></head>
<body><main><div class="card">${body}</div><p class="muted">LK-Bridge</p></main></body></html>`;
}

export function renderError(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

export function renderLogin(p: {
  readonly action: string;
  readonly returnTo: string;
  readonly csrf: string;
  readonly totp: boolean;
  readonly error?: string;
}): string {
  return layout(
    'Sign in',
    `<h1>Sign in to LK-Bridge</h1>
<p class="muted">Sign in as the bridge owner to continue.</p>
${p.error ? `<p class="err" role="alert">${escapeHtml(p.error)}</p>` : ''}
<form method="post" action="${escapeHtml(p.action)}" autocomplete="on">
<input type="hidden" name="csrf_token" value="${escapeHtml(p.csrf)}">
<input type="hidden" name="return_to" value="${escapeHtml(p.returnTo)}">
<label for="username">Username</label><input id="username" name="username" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
${
  p.totp
    ? '<label for="totp">Authenticator code</label><input id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required>'
    : ''
}
<div class="actions"><button class="primary" type="submit">Sign in</button></div>
</form>`,
  );
}

export function renderSignedIn(): string {
  return layout(
    'Signed in',
    '<h1>Signed in</h1><p>You are signed in to LK-Bridge. You can close this window.</p>',
  );
}

export interface ConsentView {
  readonly action: string;
  readonly requestId: string;
  readonly csrf: string;
  readonly owner: string;
  readonly kind: 'dcr' | 'cimd';
  readonly clientId: string;
  readonly clientName: string | null;
  /** For CIMD clients: the host serving the metadata document, which vouches for the client. */
  readonly clientHost: string | null;
  readonly redirectUri: string;
  readonly redirectHost: string;
  readonly redirectIsLoopback: boolean;
  /** True when every redirect URI the client registered is a loopback address. */
  readonly onlyLoopback: boolean;
  readonly scopes: readonly string[];
}

export function renderConsent(v: ConsentView): string {
  const who =
    v.kind === 'cimd' && v.clientHost
      ? `<p class="muted">Application published at</p><p class="host">${escapeHtml(v.clientHost)}</p>
<p class="muted">It calls itself “${escapeHtml(v.clientName ?? 'unnamed')}”. Identified by <code>${escapeHtml(v.clientId)}</code>.</p>`
      : `<p class="muted">Application</p><p class="host">${escapeHtml(v.clientName ?? 'Unnamed application')}</p>
<p class="muted">This name was supplied by the application when it registered itself and has not been verified. Client ID <code>${escapeHtml(v.clientId)}</code>.</p>`;
  const destination = v.redirectIsLoopback
    ? `${escapeHtml(v.redirectHost)} (this computer)`
    : escapeHtml(v.redirectHost);
  const loopbackWarning = v.onlyLoopback
    ? `<div class="box warn" role="note"><strong>This application only accepts sign-ins on your own computer.</strong>
<p>Its only registered return addresses are on <code>localhost</code>, so any program running on this computer could receive this authorisation. Approve only if you have just started this connection yourself, for example from Claude Code.</p></div>`
    : '';
  const scopes = v.scopes
    .map(
      (s) =>
        `<li><strong>${escapeHtml(s)}</strong>: ${escapeHtml(SCOPE_DESCRIPTIONS[s] ?? 'Access requested by the application.')}</li>`,
    )
    .join('');
  return layout(
    'Authorise access',
    `<h1>Authorise access to LK-Bridge</h1>
${who}
<div class="box"><p class="muted">After you decide, you will be sent to</p><p class="host">${destination}</p>
<p class="muted"><code>${escapeHtml(v.redirectUri)}</code></p></div>
${loopbackWarning}
<p>It is asking for:</p><ul>${scopes}</ul>
<p class="muted">Signed in as ${escapeHtml(v.owner)}. You can revoke access at any time from the dashboard.</p>
<form method="post" action="${escapeHtml(v.action)}">
<input type="hidden" name="request_id" value="${escapeHtml(v.requestId)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(v.csrf)}">
<div class="actions"><button class="primary" type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button></div>
</form>`,
  );
}
