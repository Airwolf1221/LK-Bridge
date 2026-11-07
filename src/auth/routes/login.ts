import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomToken } from '../crypto.js';
import { FormBody } from '../form.js';
import { clientIp, originAllowed, rawQuery, sendErrorPage, sendHtml } from '../http.js';
import { renderLogin, renderSignedIn } from '../pages.js';
import type { AuthServices } from '../services.js';
import { OAUTH_PATHS } from './metadata.js';

/**
 * Owner login and logout. `return_to` is limited to same-site paths under `/oauth/authorize` and
 * `/ui`, so the login page cannot be used as an open redirect.
 */
export function safeReturnTo(value: string | undefined): string | undefined {
  if (!value || value.length > 4096) return undefined;
  if (!/^\/(?:oauth\/authorize|ui)(?:[/?]|$)/.test(value)) return undefined;
  if (value.includes('\\') || [...value].some((c) => c.charCodeAt(0) < 0x20)) return undefined;
  return value;
}

export function registerLoginRoutes(app: FastifyInstance, s: AuthServices): void {
  const { config, owner } = s;

  const loginForm = (reply: FastifyReply, nonce: string, returnTo: string, status = 200, error?: string) =>
    sendHtml(
      reply,
      status,
      renderLogin({
        action: OAUTH_PATHS.login,
        returnTo,
        csrf: owner.loginCsrfToken(nonce),
        totp: owner.totpRequired,
        ...(error ? { error } : {}),
      }),
    );

  app.get(OAUTH_PATHS.login, (req: FastifyRequest, reply: FastifyReply) => {
    const returnTo = safeReturnTo(rawQuery(req).get('return_to') ?? undefined);
    if (owner.getSession(req.cookies[owner.sessionCookie]) && returnTo) {
      return reply.header('cache-control', 'no-store').redirect(returnTo, 303);
    }
    let nonce = req.cookies[owner.loginCookie];
    if (!nonce || nonce.length > 128) {
      nonce = randomToken(24);
      reply.setCookie(owner.loginCookie, nonce, owner.cookieOptions(3600));
    }
    return loginForm(reply, nonce, returnTo ?? '');
  });

  app.post(OAUTH_PATHS.login, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!originAllowed(req, config.publicUrl)) {
      return sendErrorPage(
        reply,
        403,
        'Request refused',
        'This form must be submitted from LK-Bridge itself.',
      );
    }
    if (!(req.body instanceof FormBody)) {
      return sendErrorPage(reply, 400, 'Invalid request', 'The sign-in form was not submitted correctly.');
    }
    const form = req.body;
    const nonce = req.cookies[owner.loginCookie];
    if (!owner.verifyLoginCsrf(nonce, form.get('csrf_token')) || !nonce) {
      return sendErrorPage(
        reply,
        403,
        'Request refused',
        'The sign-in form has expired. Reload the page and try again.',
      );
    }
    const returnTo = safeReturnTo(form.get('return_to'));
    const result = await owner.login({
      username: form.get('username') ?? '',
      password: form.get('password') ?? '',
      totp: form.get('totp'),
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    });
    if (!result.ok) {
      if (result.reason === 'rate_limited') {
        reply.header('retry-after', String(result.retryAfterSeconds));
        return loginForm(
          reply,
          nonce,
          returnTo ?? '',
          429,
          `Too many failed attempts. Try again in ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`,
        );
      }
      return loginForm(reply, nonce, returnTo ?? '', 401, 'Those details were not recognised.');
    }
    reply.setCookie(owner.sessionCookie, result.sessionToken, owner.cookieOptions(config.ttl.sessionSeconds));
    reply.clearCookie(owner.loginCookie, {
      path: '/',
      secure: config.secureCookies,
      httpOnly: true,
      sameSite: 'lax',
    });
    if (returnTo) return reply.header('cache-control', 'no-store').redirect(returnTo, 303);
    return sendHtml(reply, 200, renderSignedIn());
  });

  app.post(OAUTH_PATHS.logout, (req: FastifyRequest, reply: FastifyReply) => {
    if (!originAllowed(req, config.publicUrl)) {
      return sendErrorPage(
        reply,
        403,
        'Request refused',
        'This form must be submitted from LK-Bridge itself.',
      );
    }
    const token = req.cookies[owner.sessionCookie];
    const form = req.body instanceof FormBody ? req.body : undefined;
    if (!token || !owner.verifyCsrf(token, 'logout', form?.get('csrf_token'))) {
      return sendErrorPage(reply, 403, 'Request refused', 'The sign-out form token was not valid.');
    }
    owner.logout(token, clientIp(req));
    reply.clearCookie(owner.sessionCookie, {
      path: '/',
      secure: config.secureCookies,
      httpOnly: true,
      sameSite: 'lax',
    });
    return sendErrorPage(reply, 200, 'Signed out', 'You have signed out of LK-Bridge.');
  });
}
