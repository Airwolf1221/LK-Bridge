import { SCOPE_DESCRIPTIONS } from './scopes.js';
import { KEEP_SCOPE, type ExistingConnection, type StepUpToConfirm } from './services.js';

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
select{width:100%;padding:.6rem;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;font:inherit}
fieldset{border:1px solid var(--line);border-radius:8px;padding:.75rem 1rem;margin:1rem 0}legend{font-weight:600;padding:0 .25rem}
label.choice{display:flex;gap:.5rem;align-items:flex-start;font-weight:400;margin:.5rem 0}
label.choice input{width:auto;margin-top:.3rem}

/* Hotfix (ADR 0033): the new-profile fields matter only when "New profile…" is chosen. The page works without
   JavaScript (the CSP allows none): where :has() is supported the fields are hidden until that option is selected;
   anywhere else they stay visible under their heading "Only for New profile…". */
@supports selector(:has(*)){
.new-profile{display:none}
form:has(#profile option[value="new"]:checked) .new-profile{display:block}
}
.new-profile{margin-top:.5rem}
.new-profile h3{font-size:.95rem;margin:.5rem 0 0}
.existing label.choice{margin:.6rem 0}.existing .muted{display:block}
.badge{display:inline-block;font-size:.75rem;font-weight:600;padding:0 .4rem;border-radius:4px;background:var(--warn-bg);color:var(--warn-ink)}
`;

/** `10 Nov 2026, 14:02`: dates on these pages always carry the year (British English, the owner's time zone). */
export function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/London',
  });
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin"><title>${escapeHtml(title)} · LK-Bridge</title><style>${STYLE}</style></head>
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
    ? '<label for="totp">Authenticator code</label><input id="totp" name="totp" autocomplete="one-time-code" maxlength="40" required><p class="muted">The 6-digit code from your authenticator app, or one of your recovery codes if you have lost it.</p>'
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
  /** The policy profile and scope choice (src/policy). Omitted: no profile choice is shown. */
  readonly profiles?: ConsentProfileView;
  /**
   * The active connections of this same application (ADR 0033), offered for replacement: each is ticked by default and
   * revoked only when the new connection's authorisation code is exchanged. Empty or omitted: nothing is shown.
   */
  readonly existing?: readonly ExistingConnection[];
}

export interface ConsentProfileView {
  readonly options: readonly {
    id: string;
    label: string;
    kind: string;
    scope: string;
    connections?: number;
  }[];
  /** The suggested profile: an existing one with this label is preselected, else "new" with these values. */
  readonly suggested: { readonly kind: string; readonly label: string };
  readonly kinds: readonly string[];
  /**
   * The scope a NEW profile gets (the configured default, `read` out of the box). It is preselected only when the
   * suggestion is a new profile; for an existing profile the page preselects that profile's current scope (F-15).
   */
  readonly defaultScope: string;
}

/**
 * The scope radio the page preselects: always `keep` (ADR 0033), whichever profile is chosen. `keep` resolves on the
 * server to the chosen existing profile's current scope, or to the default scope for a new profile, so choosing another
 * profile in the menu can never leave a stale scope selected that would ask for a scope-change confirmation.
 */
export function preselectedScope(_p: ConsentProfileView): string {
  return KEEP_SCOPE;
}

const SCOPE_CHOICES: Readonly<Record<string, string>> = {
  read: 'Read only: it can read the LegendKeeper project; every write is refused.',
  propose:
    'Propose: its writes become proposals that you approve or reject in the dashboard. Nothing is written until you approve.',
  write: 'Write: its writes run at once (the bridge’s safety guards still apply).',
};

function renderProfileChoice(p: ConsentProfileView): string {
  const existing = p.options.find((o) => o.label.toLowerCase() === p.suggested.label.toLowerCase());
  const options = p.options
    .map(
      (o) =>
        `<option value="${escapeHtml(o.id)}"${existing?.id === o.id ? ' selected' : ''}>${escapeHtml(o.label)} (${escapeHtml(o.kind)}, currently ${escapeHtml(o.scope)})</option>`,
    )
    .join('');
  const kinds = p.kinds
    .map(
      (k) =>
        `<option value="${escapeHtml(k)}"${k === p.suggested.kind ? ' selected' : ''}>${escapeHtml(k)}</option>`,
    )
    .join('');
  const checked = preselectedScope(p);
  const explicit = Object.entries(SCOPE_CHOICES)
    .map(
      ([v, text]) =>
        `<label class="choice"><input type="radio" name="scope" value="${v}"${v === checked ? ' checked' : ''}><span><strong>${v}</strong>: ${escapeHtml(text.slice(text.indexOf(':') + 2))}</span></label>`,
    )
    .join('');
  const keep = `<label class="choice"><input type="radio" name="scope" value="${KEEP_SCOPE}"${checked === KEEP_SCOPE ? ' checked' : ''}><span><strong>Keep the chosen profile’s current scope</strong>: changes nothing for an existing profile; a new profile starts at ${escapeHtml(p.defaultScope)}, the default for new connections.</span></label>`;
  const preselectNote = existing
    ? `<p class="muted">Preselected: keep the current scope of whichever profile is chosen (profile “${escapeHtml(existing.label)}” is currently ${escapeHtml(existing.scope)}), so approving without changing anything leaves its scope as it is. Choosing read, propose or write below sets that scope on the chosen profile, after you confirm.</p>`
    : `<p class="muted">Preselected: keep the current scope of the chosen profile. A new profile starts at ${escapeHtml(p.defaultScope)}, the default for new connections.</p>`;
  return `<fieldset><legend>Profile</legend>
<p class="muted">The connection acts under a profile. Permissions belong to the profile and apply at once to every connection that uses it.</p>
<label for="profile">Use profile</label>
<select id="profile" name="profile">${options}<option value="new"${existing ? '' : ' selected'}>New profile…</option></select>
<div class="new-profile">
<h3>Only for New profile…</h3>
<label for="new_label">New profile label</label><input id="new_label" name="new_label" value="${escapeHtml(p.suggested.label)}" maxlength="64">
<label for="new_kind">New profile kind</label><select id="new_kind" name="new_kind">${kinds}</select>
</div>
</fieldset>
<fieldset><legend>Scope</legend>
<p class="muted">Applies to the chosen profile, so it also changes what other connections on that profile may do. Changing an existing profile’s scope asks you to confirm first.</p>
${preselectNote}
${keep}
${explicit}
</fieldset>`;
}

/**
 * "This application's existing connections" (ADR 0033): the same application's other active connections, ticked by
 * default. Nothing is revoked at approval: the ticked ones are revoked when the new connection's code is exchanged.
 */
function renderExisting(list: readonly ExistingConnection[]): string {
  if (list.length === 0) return '';
  const rows = list
    .map(
      (c) =>
        `<label class="choice"><input type="checkbox" name="replace" value="${escapeHtml(c.id)}" checked><span><strong>${escapeHtml(c.label)}</strong>
<span class="muted">Profile: ${escapeHtml(c.profile ?? 'none')} · created ${escapeHtml(formatWhen(c.createdAt))} · last used ${c.lastUsedAt === null ? 'never' : escapeHtml(formatWhen(c.lastUsedAt))}</span></span></label>`,
    )
    .join('');
  return `<fieldset class="existing"><legend>This application's existing connections</legend>
<p class="muted">Ticked connections are revoked as soon as this new connection is issued. Untick one to keep it, for example a second device or a separate Claude Code session.</p>
${rows}
</fieldset>`;
}

/** The confirmation page for a scope change to an existing profile (F-15). Re-posts the consent form. */
export interface ScopeConfirmView {
  readonly action: string;
  readonly requestId: string;
  readonly csrf: string;
  readonly redirectHost: string;
  readonly profileId: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly connections: number;
  readonly token: string;
  /** The existing connections the owner ticked for replacement: carried through the confirmation unchanged. */
  readonly replace?: readonly string[];
}

export function renderScopeConfirm(v: ScopeConfirmView): string {
  const others =
    v.connections === 0
      ? 'No other connection uses it yet.'
      : `${v.connections} existing connection${v.connections === 1 ? '' : 's'} on this profile will change too, at once.`;
  const raise = ['read', 'propose', 'write'].indexOf(v.to) > ['read', 'propose', 'write'].indexOf(v.from);
  return layout(
    'Confirm scope change',
    `<h1>Change the scope of profile “${escapeHtml(v.label)}”?</h1>
<div class="box warn" role="alert"><strong>This affects every connection on the profile “${escapeHtml(v.label)}”, not only this one.</strong>
<p>Its scope would change from <strong>${escapeHtml(v.from)}</strong> to <strong>${escapeHtml(v.to)}</strong>${raise ? ' (a raise)' : ' (a lowering)'}. ${escapeHtml(others)}</p></div>
<p class="muted">The connection you are approving goes to ${escapeHtml(v.redirectHost)}. Nothing has been changed yet.</p>
<form method="post" action="${escapeHtml(v.action)}">
<input type="hidden" name="request_id" value="${escapeHtml(v.requestId)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(v.csrf)}">
<input type="hidden" name="decision" value="approve">
<input type="hidden" name="profile" value="${escapeHtml(v.profileId)}">
<input type="hidden" name="confirm_scope_change" value="${escapeHtml(v.token)}">
${(v.replace ?? []).map((id) => `<input type="hidden" name="replace" value="${escapeHtml(id)}">`).join('\n')}
<div class="actions"><button class="primary" type="submit" name="scope" value="${escapeHtml(v.to)}">Change to ${escapeHtml(v.to)} and approve</button>
<button type="submit" name="scope" value="${escapeHtml(v.from)}">Keep ${escapeHtml(v.from)} and approve</button></div>
</form>
<p class="muted">To deny the connection instead, go back and choose Deny.</p>`,
  );
}

/**
 * CR-2026-11-R4 (ADR 0062 decision 5): the step-up asked on the consent page itself, before a choice that lets the
 * connection do more is applied (a raised scope, a new profile above the default, a connection at scope `write`). It
 * re-posts the same pending request with the owner's choice unchanged, plus the authenticator code (or a recovery
 * code), or the password when no authenticator is set up.
 */
export interface ConsentStepUpView {
  readonly action: string;
  readonly requestId: string;
  readonly csrf: string;
  readonly redirectHost: string;
  /** The choice the owner made (profile, scope, new profile's label and kind, the scope change's confirmation). */
  readonly fields: Readonly<Record<string, string | undefined>>;
  /** The existing connections the owner ticked for replacement: carried through unchanged. */
  readonly replace?: readonly string[];
  readonly need: StepUpToConfirm;
  /** The authenticator is set up: its code (or a recovery code) is asked; otherwise the password. */
  readonly totp: boolean;
  /** ADR 0081: how long a step-up lasts, in words ("12 hours": `AUTH_STEP_UP_WINDOW_SECONDS`). */
  readonly window: string;
  /** Why the last attempt was refused (a wrong code, too many attempts). */
  readonly error?: string;
}

function stepUpWhy(n: StepUpToConfirm): { headline: string; detail: string } {
  const label = `“${escapeHtml(n.label)}”`;
  const writes =
    n.to === 'write'
      ? ' At scope write its writes run at once (the bridge’s safety guards still apply).'
      : '';
  switch (n.why) {
    case 'raise':
      return {
        headline: `This raises the scope of profile ${label} from ${escapeHtml(n.from ?? '')} to ${escapeHtml(n.to)}.`,
        detail: `Every connection on the profile can then do more, at once.${writes}`,
      };
    case 'new_profile':
      return {
        headline: `This makes a new profile ${label} at scope ${escapeHtml(n.to)}.`,
        detail: `New connections start at ${escapeHtml(n.defaultScope)}, the default.${writes}`,
      };
    default:
      return {
        headline: `This connection would act under profile ${label}, at scope ${escapeHtml(n.to)}.`,
        detail: `It is a credential that can write to LegendKeeper, as a personal access token at that scope is.${writes}`,
      };
  }
}

export function renderConsentStepUp(v: ConsentStepUpView): string {
  const why = stepUpWhy(v.need);
  const hidden = Object.entries(v.fields)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, val]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(val)}">`)
    .join('\n');
  const field = v.totp
    ? '<label for="stepup">Authenticator code</label><input id="stepup" name="stepup_totp" autocomplete="one-time-code" maxlength="40" required autofocus><p class="muted">The 6-digit code from your authenticator app, or one of your recovery codes if you have lost it.</p>'
    : '<label for="stepup">Password</label><input id="stepup" name="stepup_password" type="password" autocomplete="current-password" required autofocus>';
  return layout(
    'Confirm it’s you',
    `<h1>Confirm it’s you</h1>
<div class="box warn" role="note"><strong>${why.headline}</strong>
<p>${why.detail}</p></div>
${v.error ? `<p class="err" role="alert">${escapeHtml(v.error)}</p>` : ''}
<p class="muted">As on the dashboard, a change that lets a connection do more needs ${v.totp ? 'your authenticator code' : 'your password'}, checked within the last ${escapeHtml(v.window)}. Nothing has been changed yet. The connection you are approving goes to ${escapeHtml(v.redirectHost)}.</p>
<form method="post" action="${escapeHtml(v.action)}">
<input type="hidden" name="request_id" value="${escapeHtml(v.requestId)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(v.csrf)}">
${hidden}
${(v.replace ?? []).map((id) => `<input type="hidden" name="replace" value="${escapeHtml(id)}">`).join('\n')}
${field}
<div class="actions"><button class="primary" type="submit" name="decision" value="approve">Confirm and approve</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button></div>
</form>`,
  );
}

export function renderConsent(v: ConsentView): string {
  const who =
    v.kind === 'cimd' && v.clientHost
      ? `<p class="muted">Application published at</p><p class="host">${escapeHtml(v.clientHost)}</p>
<p class="muted">It calls itself “${escapeHtml(v.clientName ?? 'unnamed')}” <span class="badge">untrusted name</span>. Identified by <code>${escapeHtml(v.clientId)}</code>.</p>`
      : `<p class="muted">Application <span class="badge">untrusted name</span></p><p class="host">${escapeHtml(v.clientName ?? 'Unnamed application')}</p>
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
${v.profiles ? renderProfileChoice(v.profiles) : ''}
${v.profiles && v.existing ? renderExisting(v.existing) : ''}
<div class="actions"><button class="primary" type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button></div>
</form>`,
  );
}
