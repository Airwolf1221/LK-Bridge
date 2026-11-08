/**
 * Who may call `/api/admin`: the owner's session cookie, and nothing else.
 *
 * - The credential is the owner session cookie set by the sign-in page (chunk 4). An `Authorization` header is never
 *   read, so OAuth access tokens and personal access tokens do nothing here, however valid they are at `/mcp`.
 * - Every state-changing request (anything but GET, HEAD, OPTIONS) also needs a matching `Origin` (the bridge's own
 *   public URL; a missing or foreign one is refused) and the CSRF token bound to the session, in `X-CSRF-Token`.
 * - Unauthenticated requests get a 401 JSON body with no `WWW-Authenticate` header (it would suggest a bearer token).
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

export function adminGuard(s: AuthServices) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    reply
      .header('cache-control', 'no-store')
      .header('pragma', 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer');
    const token = req.cookies[s.owner.sessionCookie];
    if (!token || !s.owner.getSession(token)) {
      return sendError(
        reply,
        new AdminHttpError(401, 'UNAUTHENTICATED', 'Sign in as the owner to use the dashboard.'),
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
