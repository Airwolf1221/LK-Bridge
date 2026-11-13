/**
 * Two small public pages, `GET /about` and `GET /privacy` (ADR 0043, addendum): the application home page and privacy
 * policy links that Google requires before an external app can be published. Static HTML: no sign-in, no cookie, no
 * script, and the bridge's strict dashboard CSP (so the styling is a same-origin stylesheet, `/public.css`, because that
 * policy allows no inline style). The only dynamic text is the contact email setting, HTML-escaped; unset, the line is
 * left out. `GET /` is not touched.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { escapeHtml } from '../auth/pages.js';
import { uiSecurityHeaders } from '../admin/ui.js';
import { readContactEmail } from '../admin/runtime-settings.js';
import type { Db } from '../db/open.js';

export const PUBLIC_PATHS = { about: '/about', privacy: '/privacy', css: '/public.css' } as const;

export const PUBLIC_CSS = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#5d5b55;--line:#dedbd3;--accent:#2f5d50}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#21201d;--ink:#eeece6;--muted:#a9a69d;--line:#3a3934;--accent:#7fc1ad}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:40rem;margin:2.5rem auto;padding:0 1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.5rem}
h1{font-size:1.45rem;margin:0 0 1rem}p{margin:.6rem 0}ul{padding-left:1.2rem}li{margin:.35rem 0}
a{color:var(--accent)}code{word-break:break-all}.muted{color:var(--muted);font-size:.9rem}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · LK-Bridge</title><link rel="stylesheet" href="${PUBLIC_PATHS.css}"></head>
<body><main><div class="card">${body}</div>
<p class="muted"><a href="${PUBLIC_PATHS.about}">About</a> · <a href="${PUBLIC_PATHS.privacy}">Privacy</a></p></main></body></html>
`;
}

export function renderAbout(): string {
  return page(
    'About',
    `<h1>About LK-Bridge</h1>
<p>LK-Bridge is a private bridge that connects one owner’s LegendKeeper worldbuilding projects to their AI assistants.
It runs on the owner’s own server.</p>
<p>It has no public accounts and no public sign-up. Only its owner can sign in, and it is not a service offered to anyone
else.</p>
<p>Read how it treats Google data in the <a href="${PUBLIC_PATHS.privacy}">privacy policy</a>.</p>`,
  );
}

export function renderPrivacy(contactEmail: string | null): string {
  const contact =
    contactEmail === null
      ? ''
      : `<h2>Contact</h2><p>Questions about this policy: ${escapeHtml(contactEmail)}</p>`;
  return page(
    'Privacy policy',
    `<h1>Privacy policy</h1>
<p>LK-Bridge is a private bridge run by one owner on their own server (<a href="${PUBLIC_PATHS.about}">about</a>). It has
no public accounts. This page says what it does with Google data.</p>
<h2>What it uses Google for</h2>
<p>The owner can connect their own Google Drive so that the bridge keeps an off-site copy of its backups.</p>
<ul>
<li>It requests only the <code>drive.file</code> permission.</li>
<li>It stores only its own encrypted backup files in the owner’s Google Drive. It cannot see or read any other file in
that Drive.</li>
<li>Backups are encrypted before they are uploaded, with keys that only the owner holds. Google sees only encrypted files
with encrypted names.</li>
<li>It shares nothing with anyone: no Google data is sold, given or shown to any other person or service.</li>
<li>The refresh token that lets the bridge reach Drive is kept encrypted on the owner’s server. The owner can revoke it
from the bridge’s dashboard (Disconnect) or from the Google account’s third-party access settings.</li>
</ul>${contact}`,
  );
}

function publicHeaders(reply: FastifyReply): FastifyReply {
  // Revalidated each time, so a changed contact email shows at once.
  return uiSecurityHeaders(reply).header('cache-control', 'no-cache');
}

export function registerPublicPages(app: FastifyInstance, db: Db): void {
  const html = (render: () => string) => (_req: unknown, reply: FastifyReply) =>
    publicHeaders(reply).type('text/html; charset=utf-8').send(render());
  app.get(PUBLIC_PATHS.about, html(renderAbout));
  // Read on each request, so a change on the dashboard applies at once.
  app.get(
    PUBLIC_PATHS.privacy,
    html(() => renderPrivacy(readContactEmail(db))),
  );
  app.get(PUBLIC_PATHS.css, (_req, reply) =>
    publicHeaders(reply).type('text/css; charset=utf-8').send(PUBLIC_CSS),
  );
}
