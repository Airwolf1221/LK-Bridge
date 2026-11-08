import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OAuthError } from './errors.js';
import { renderError } from './pages.js';

/** Shared HTTP helpers for the auth routes. */

/** Security headers for every HTML page. `formTargets` are extra origins a form may post or redirect to. */
export function htmlHeaders(reply: FastifyReply, formTargets: readonly string[] = []): FastifyReply {
  // Chrome applies form-action to the redirect that follows a form POST, so the consent page must
  // also allow the client's redirect origin, or the final redirect to Claude would be blocked.
  const formAction = ["'self'", ...formTargets].join(' ');
  return (
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('pragma', 'no-cache')
      .header('x-frame-options', 'DENY')
      .header('x-content-type-options', 'nosniff')
      // `same-origin`, not `no-referrer`: a browser serialises the Origin of a FORM POST as "null" under no-referrer, and the
      // sign-in, consent and sign-out forms are checked against the bridge's own Origin. Nothing is sent to other sites either way.
      .header('referrer-policy', 'same-origin')
      .header(
        'content-security-policy',
        `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      )
  );
}

export function sendHtml(
  reply: FastifyReply,
  status: number,
  html: string,
  formTargets: readonly string[] = [],
) {
  return htmlHeaders(reply, formTargets).code(status).send(html);
}

export function sendErrorPage(reply: FastifyReply, status: number, title: string, message: string) {
  return sendHtml(reply, status, renderError(title, message));
}

/** JSON OAuth error response, with `no-store` as RFC 6749 §5.1 requires for token responses. */
export function sendOAuthError(reply: FastifyReply, err: OAuthError) {
  for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
  return reply
    .code(err.status)
    .header('cache-control', 'no-store')
    .header('pragma', 'no-cache')
    .type('application/json')
    .send(err.toJSON());
}

/** Permissive CORS for the metadata, registration, token and revocation endpoints (no cookies). */
export function cors(reply: FastifyReply): FastifyReply {
  return reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-methods', 'GET, POST, OPTIONS')
    .header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version')
    .header('access-control-max-age', '600');
}

/** Same-origin check for browser form POSTs: a present `Origin` must be this bridge. */
export function originAllowed(req: FastifyRequest, publicUrl: string): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === publicUrl;
}

export function clientIp(req: FastifyRequest): string {
  return req.ip;
}

/** Appends OAuth response parameters to a redirect URI, keeping any query it already has. */
export function redirectWith(
  redirectUri: string,
  params: Readonly<Record<string, string | undefined>>,
): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** Raw query parameters of a request (keeps repeats, unlike Fastify's parsed query). */
export function rawQuery(req: FastifyRequest): URLSearchParams {
  const i = req.url.indexOf('?');
  return new URLSearchParams(i >= 0 ? req.url.slice(i + 1) : '');
}
