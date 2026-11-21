/**
 * Who may call `/api/admin`: the owner's session cookie, and nothing else.
 *
 * - The credential is the owner session cookie set by the sign-in page (chunk 4). An `Authorization` header is never
 *   read, so OAuth access tokens and personal access tokens do nothing here, however valid they are at `/mcp`.
 * - Every state-changing request (anything but GET, HEAD, OPTIONS) also needs a matching `Origin` (the bridge's own
 *   public URL; a missing or foreign one is refused) and the CSRF token bound to the session, in `X-CSRF-Token`.
 * - Unauthenticated requests get a 401 JSON body with no `WWW-Authenticate` header (it would suggest a bearer token).
 * - Requests a browser labels `Sec-Fetch-Site: cross-site` or `same-site` are refused (403 `CROSS_SITE`), reads too.
 * - ADR 0062, CR-2026-11-R4: a request is a use of the session (its end moves 30 days on, its cookie is renewed) unless
 *   it is the dashboard's own (`X-LKB-Background: 1`) or the live stream, which are only checked.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthServices } from '../auth/services.js';
import { AdminHttpError, sendError } from './http.js';

/** The CSRF token purpose for the dashboard. Distinct from `logout` and the consent screens. */
export const ADMIN_CSRF_PURPOSE = 'admin';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const sessions = new WeakMap<FastifyRequest, string>();

/** The session token of an authenticated admin request (only set after the guard has passed). */
export function sessionTokenOf(req: FastifyRequest): string {
  const t = sessions.get(req);
  if (!t) throw new AdminHttpError(401, 'UNAUTHENTICATED', 'Sign in as the owner to use the dashboard.');
  return t;
}

/**
 * CR-2026-11-R4 (ADR 0062 decision 1; SE-42, SE-43): the header the dashboard sends, `1`, on every request it makes
 * without the owner's input (a refresh on a timer, a reload for a live event or for the stream starting afresh, the
 * session check after the stream drops). Such a request is checked as the live stream's periodic check is: its session
 * must be live, but it is not a use (its end does not move, its cookie is not renewed), so an idle open tab does not
 * keep the session alive. The owner's own actions and page loads are uses, as before.
 */
export const BACKGROUND_HEADER = 'x-lkb-background';

/** The live stream: the dashboard opens it by itself, and again after each drop; an EventSource cannot send a header. */
const STREAM_ROUTE = '/api/admin/stream';

/** Whether a request is the dashboard's own (`BACKGROUND_HEADER`, or the live stream), so not a use of the session. */
export function isBackgroundRequest(req: FastifyRequest): boolean {
  const h = req.headers[BACKGROUND_HEADER];
  return (Array.isArray(h) ? h[0] : h) === '1' || req.routeOptions.url === STREAM_ROUTE;
}

/**
 * ADR 0062: whether this request's session stepped up within the last 10 minutes (the authenticator code, or the
 * password when no authenticator is set up). Read without counting as a use (the guard has already counted it).
 */
export function hasStepUp(s: AuthServices, req: FastifyRequest): boolean {
  const session = s.owner.peekSession(sessionTokenOf(req));
  return session !== undefined && s.owner.reauthUntil(session) !== null;
}

/**
 * OPS2: sensitive actions (adding, replacing or removing a key; the password; the authenticator) need the owner to have
 * stepped up on this session within the last 10 minutes (ADR 0062: the authenticator code, or the password when no
 * authenticator is set up), even when signed in. Throws 403 `REAUTH_REQUIRED` otherwise. Returns the session token.
 */
export function requireReauth(s: AuthServices, req: FastifyRequest): string {
  const token = sessionTokenOf(req);
  if (!hasStepUp(s, req)) {
    throw new AdminHttpError(
      403,
      'REAUTH_REQUIRED',
      'Confirm it is you first (your authenticator code, or your password without one): this action needs a fresh check, within the last 10 minutes.',
    );
  }
  return token;
}

export function adminGuard(s: AuthServices) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    reply
      .header('cache-control', 'no-store')
      .header('pragma', 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer');
    const token = req.cookies[s.owner.sessionCookie];
    // CR-2026-11-R4: the dashboard's own requests (and the live stream) are checked without counting as a use.
    const background = isBackgroundRequest(req);
    const used = !token
      ? undefined
      : background
        ? s.owner.peekSession(token) !== undefined
          ? { renewed: false }
          : undefined
        : s.owner.useSession(token);
    if (!token || !used) {
      return sendError(
        reply,
        new AdminHttpError(401, 'UNAUTHENTICATED', 'Sign in as the owner to use the dashboard.'),
      );
    }
    // ADR 0062: a sliding session (30 days from its last use): its cookie's Max-Age renewed with it.
    if (used.renewed) reply.setCookie(s.owner.sessionCookie, token, s.owner.sessionCookieOptions());
    // Chunk 8 (F-08): admin reads need no CSRF token, and some spend budget (overview refresh, mapping preview, P0).
    // The session cookie was SameSite=Lax then, so a top-level navigation from another site carried it; since ADR 0062 it
    // is Strict, and this check stays as a second line. Browsers label every request with Sec-Fetch-Site: the
    // dashboard's own requests are `same-origin`, an address typed into the bar is `none`. Anything from another site is
    // refused, reads included.
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') {
      return sendError(
        reply,
        new AdminHttpError(403, 'CROSS_SITE', 'The dashboard API answers only the dashboard itself.'),
      );
    }
    if (!SAFE_METHODS.has(req.method)) {
      if (req.headers.origin !== s.config.publicUrl) {
        return sendError(
          reply,
          new AdminHttpError(403, 'BAD_ORIGIN', 'This request must come from the dashboard itself.'),
        );
      }
      const header = req.headers['x-csrf-token'];
      const presented = Array.isArray(header) ? header[0] : header;
      if (!s.owner.verifyCsrf(token, ADMIN_CSRF_PURPOSE, presented)) {
        return sendError(
          reply,
          new AdminHttpError(
            403,
            'BAD_CSRF',
            'The security token is missing or has expired. Reload the page.',
          ),
        );
      }
    }
    sessions.set(req, token);
    return undefined;
  };
}
