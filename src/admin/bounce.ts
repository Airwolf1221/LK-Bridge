import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * ADR 0062: the owner's session cookie is `SameSite=Strict`, so a navigation from another site arrives without it. Three
 * pages are reached that way (the OAuth consent page from Claude, the Google Drive sign-in's return, and a link to the
 * dashboard from elsewhere). Each answers such a navigation, once, with this tiny page of the bridge's own, which opens
 * the same address again from the bridge: a same-origin navigation, which carries the cookie. A signed-in owner sees the
 * page as before; one not signed in is then asked to sign in, as before. The page holds no script (a refresh and a
 * link), so the strict Content-Security-Policy applies unchanged.
 *
 * Never twice in a row: the bounce sets a short-lived `SameSite=Lax` marker (sent on the next navigation, whatever the
 * browser calls it), and a request that carries it is answered as it would have been without the bounce (at worst the
 * sign-in page), so a browser that still labelled the second navigation cross-site cannot loop.
 */

/** How long the marker lasts: enough for the refresh to happen. */
const MARK_SECONDS = 30;

const markCookie = (sessionCookie: string) =>
  sessionCookie.startsWith('__Host-') ? '__Host-lkb_bounced' : 'lkb_bounced';

/** Whether `req` is a cross-site navigation that arrived without the session cookie (and so is to be bounced once). */
export function needsBounce(req: FastifyRequest, sessionCookie: string): boolean {
  return (
    req.method === 'GET' &&
    req.headers['sec-fetch-site'] === 'cross-site' &&
    req.cookies[sessionCookie] === undefined &&
    req.cookies[markCookie(sessionCookie)] === undefined
  );
}

const attr = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');

/** The request's query string (with its `?`), or nothing: to keep it on a route's own path. */
export function queryOf(req: FastifyRequest): string {
  const q = req.url.indexOf('?');
  return q >= 0 ? req.url.slice(q) : '';
}

/**
 * The bounce page for `to`: a path of the bridge's own (the caller builds it from its route's path, or checks it, so it
 * can only open a page of the bridge), with its query; and the marker that stops a second bounce.
 */
export function sendBounce(reply: FastifyReply, to: string, sessionCookie: string): FastifyReply {
  if (!to.startsWith('/') || to.startsWith('//') || to.startsWith('/\\')) to = '/ui';
  const target = attr(to);
  return reply
    .setCookie(markCookie(sessionCookie), '1', {
      httpOnly: true,
      secure: sessionCookie.startsWith('__Host-'),
      sameSite: 'lax',
      path: '/',
      maxAge: MARK_SECONDS,
    })
    .code(200)
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff')
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}">` +
        `<meta name="robots" content="noindex"><title>LK-Bridge</title></head>` +
        `<body><p><a href="${target}">Continue to LK-Bridge</a></p></body></html>`,
    );
}
