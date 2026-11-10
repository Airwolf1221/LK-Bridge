import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CimdError, isCimdClientId, validateCimdUrl } from '../cimd.js';
import { CODE_CHALLENGE_S256 } from '../crypto.js';
import { OAuthError } from '../errors.js';
import { FormBody } from '../form.js';
import { originAllowed, rawQuery, redirectWith, sendErrorPage, sendHtml } from '../http.js';
import { renderConsent, renderScopeConfirm } from '../pages.js';
import { findRegisteredRedirect, isAllowedRedirectUri, isLoopbackRedirect } from '../redirect-uris.js';
import { ScopeSyntaxError, grantableScopes, parseScope } from '../scopes.js';
import type { AuthServices } from '../services.js';
import type { ClientRecord } from '../store.js';
import { resolveResource } from '../tokens.js';
import { displayHost } from '../url.js';
import { LEGACY_ALIASES, OAUTH_PATHS } from './metadata.js';

/**
 * Authorization endpoint (RFC 6749 §4.1.1, OAuth 2.1, RFC 7636, RFC 8707, RFC 9207) and the
 * owner's consent decision.
 *
 * Problems with `client_id` or `redirect_uri` are shown as an error page and never redirected
 * (RFC 6749 §4.1.2.1). Every other error is returned to the client's redirect URI with `state`
 * and `iss`.
 */

const SINGLE_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'state',
  'scope',
  'code_challenge',
  'code_challenge_method',
  'response_mode',
  'prompt',
];

class RedirectError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
  ) {
    super(description);
  }
}

export function registerAuthorizeRoutes(app: FastifyInstance, s: AuthServices): void {
  const { config } = s;

  const authorize = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = rawQuery(req);
    const repeated = SINGLE_PARAMS.filter((k) => q.getAll(k).length > 1);
    const get = (k: string) => {
      const v = q.get(k);
      return v === null || v === '' ? undefined : v;
    };

    // 1. Client and redirect URI. Failures here are never redirected.
    if (repeated.includes('client_id') || repeated.includes('redirect_uri')) {
      return sendErrorPage(reply, 400, 'Invalid request', 'client_id and redirect_uri must not be repeated.');
    }
    const clientId = get('client_id');
    if (!clientId) return sendErrorPage(reply, 400, 'Invalid request', 'The request has no client_id.');
    const sessionToken = req.cookies[s.owner.sessionCookie];
    const session = s.owner.getSession(sessionToken);
    const toLogin = () => {
      const returnTo = req.url.startsWith(OAUTH_PATHS.authorize)
        ? req.url
        : `${OAUTH_PATHS.authorize}${req.url.slice(LEGACY_ALIASES.authorize.length)}`;
      return reply
        .header('cache-control', 'no-store')
        .redirect(`${OAUTH_PATHS.login}?${new URLSearchParams({ return_to: returnTo }).toString()}`, 302);
    };
    let client: ClientRecord | undefined;
    try {
      if (isCimdClientId(clientId)) {
        validateCimdUrl(clientId);
        // Fetch a metadata document only for the signed-in owner, so that nobody else can make the
        // bridge fetch URLs of their choosing. A fresh cached document may be used before sign-in.
        if ((!session || !sessionToken) && !s.clients.freshCimd(clientId)) {
          if (get('prompt') === 'none') {
            return sendErrorPage(reply, 400, 'Sign-in required', 'Sign in to LK-Bridge, then try again.');
          }
          return toLogin();
        }
      }
      client = await s.clients.resolveForAuthorization(clientId);
    } catch (err) {
      if (!(err instanceof CimdError)) throw err;
      s.event(
        'authorize.rejected',
        {
          client_id: clientId,
          reason: 'client_metadata',
          detail: err.message,
          field: err.field,
          value: err.value,
        },
        'warn',
      );
      return sendErrorPage(
        reply,
        400,
        'Application not accepted',
        `The application could not be verified: ${err.message}.`,
      );
    }
    if (!client) {
      s.event('authorize.rejected', { client_id: clientId, reason: 'unknown_client' }, 'warn');
      return sendErrorPage(
        reply,
        400,
        'Unknown application',
        'This application is not registered with LK-Bridge. In Claude, remove the connector and add it again.',
      );
    }
    const requestedRedirect = get('redirect_uri');
    let redirectUri: string;
    if (requestedRedirect === undefined) {
      const only = client.redirectUris.length === 1 ? client.redirectUris[0] : undefined;
      if (only === undefined || isLoopbackRedirect(only)) {
        return sendErrorPage(reply, 400, 'Invalid request', 'The request has no redirect_uri.');
      }
      redirectUri = only;
    } else {
      if (
        !findRegisteredRedirect(requestedRedirect, client.redirectUris) ||
        !isAllowedRedirectUri(requestedRedirect, config.extraRedirectUris)
      ) {
        s.event(
          'authorize.rejected',
          { client_id: clientId, reason: 'redirect_uri', redirect_uri: requestedRedirect.slice(0, 300) },
          'warn',
        );
        return sendErrorPage(
          reply,
          400,
          'Invalid redirect',
          'The redirect_uri is not registered for this application, so LK-Bridge will not send you there.',
        );
      }
      redirectUri = requestedRedirect;
    }

    // 2. Everything else is reported to the client.
    const state = get('state');
    const sendBack = (params: Record<string, string | undefined>) =>
      reply
        .code(302)
        .header('cache-control', 'no-store')
        .redirect(redirectWith(redirectUri, { ...params, state, iss: config.issuer }), 302);
    try {
      if (repeated.length > 0)
        throw new RedirectError('invalid_request', `Parameter repeated: ${repeated.join(', ')}`);
      if (q.has('request'))
        throw new RedirectError('request_not_supported', 'Request objects are not supported');
      if (q.has('request_uri'))
        throw new RedirectError('request_uri_not_supported', 'request_uri is not supported');
      const responseType = get('response_type');
      if (!responseType) throw new RedirectError('invalid_request', 'response_type is required');
      if (responseType !== 'code' || !client.responseTypes.includes('code')) {
        throw new RedirectError('unsupported_response_type', 'Only response_type=code is supported');
      }
      const responseMode = get('response_mode');
      if (responseMode !== undefined && responseMode !== 'query') {
        throw new RedirectError('invalid_request', 'Only response_mode=query is supported');
      }
      const codeChallenge = get('code_challenge');
      if (!codeChallenge)
        throw new RedirectError('invalid_request', 'code_challenge is required (PKCE with S256)');
      if (get('code_challenge_method') !== 'S256') {
        throw new RedirectError('invalid_request', 'code_challenge_method must be S256');
      }
      if (!CODE_CHALLENGE_S256.test(codeChallenge)) {
        throw new RedirectError(
          'invalid_request',
          'code_challenge must be a base64url SHA-256 digest (43 characters)',
        );
      }
      let scopes: string[];
      try {
        scopes = grantableScopes(parseScope(get('scope')));
      } catch (err) {
        if (err instanceof ScopeSyntaxError) throw new RedirectError('invalid_scope', err.message);
        throw err;
      }
      let resource: string;
      try {
        resource = resolveResource(
          q.getAll('resource').filter((r) => r !== ''),
          config,
        );
      } catch (err) {
        if (err instanceof OAuthError) throw new RedirectError(err.error, err.description);
        throw err;
      }

      // 3. The owner must be signed in.
      const prompt = get('prompt');
      if (!session || !sessionToken) {
        if (prompt === 'none') throw new RedirectError('login_required', 'The owner is not signed in');
        return toLogin();
      }
      if (prompt === 'none')
        throw new RedirectError('consent_required', 'Approval is required for every connection');

      // 4. Ask for consent.
      const pending = s.consents.create({
        sessionHash: s.sessionHash(sessionToken),
        clientId: client.clientId,
        redirectUri,
        redirectUriProvided: requestedRedirect !== undefined,
        codeChallenge,
        scopes,
        resource,
        state,
      });
      s.event('consent.shown', { client_id: client.clientId, redirect_host: displayHost(redirectUri) });
      const html = renderConsent({
        action: OAUTH_PATHS.consent,
        requestId: pending.id,
        csrf: s.owner.csrfToken(sessionToken, `consent:${pending.id}`),
        owner: config.owner.username,
        kind: client.kind,
        clientId: client.clientId,
        clientName: client.clientName,
        clientHost: client.kind === 'cimd' ? displayHost(client.clientId) : null,
        redirectUri,
        redirectHost: displayHost(redirectUri),
        redirectIsLoopback: isLoopbackRedirect(redirectUri),
        onlyLoopback: client.redirectUris.every((u) => isLoopbackRedirect(u)),
        scopes,
        ...(s.profiles
          ? {
              profiles: {
                options: s.profiles.options(),
                suggested: s.profiles.suggest(redirectUri),
                kinds: s.profiles.kinds,
                defaultScope: s.profiles.defaultScope(),
              },
              // ADR 0033: this application's other active connections, offered for replacement (ticked by default).
              existing: s.profiles.existingConnections({
                clientId: client.clientId,
                kind: client.kind,
                redirectUri,
              }),
            }
          : {}),
      });
      return sendHtml(reply, 200, html, [new URL(redirectUri).origin]);
    } catch (err) {
      if (!(err instanceof RedirectError)) throw err;
      s.event('authorize.rejected', { client_id: clientId, reason: err.error }, 'warn');
      return sendBack({ error: err.error, error_description: err.description });
    }
  };

  const consent = (req: FastifyRequest, reply: FastifyReply) => {
    if (!originAllowed(req, config.publicUrl)) {
      return sendErrorPage(
        reply,
        403,
        'Request refused',
        'This form must be submitted from LK-Bridge itself.',
      );
    }
    if (!(req.body instanceof FormBody)) {
      return sendErrorPage(reply, 400, 'Invalid request', 'The consent form was not submitted correctly.');
    }
    const form = req.body;
    const sessionToken = req.cookies[s.owner.sessionCookie];
    const session = s.owner.getSession(sessionToken);
    if (!session || !sessionToken) {
      return sendErrorPage(
        reply,
        401,
        'Signed out',
        'Your sign-in has expired. Start the connection again from Claude.',
      );
    }
    const requestId = form.get('request_id');
    const pending = s.consents.get(requestId);
    if (!pending || !requestId || pending.sessionHash !== s.sessionHash(sessionToken)) {
      return sendErrorPage(
        reply,
        400,
        'Request expired',
        'This authorisation request has expired or was already answered. Start the connection again from Claude.',
      );
    }
    if (!s.owner.verifyCsrf(sessionToken, `consent:${requestId}`, form.get('csrf_token'))) {
      return sendErrorPage(
        reply,
        403,
        'Request refused',
        'The form token was not valid. Start again from Claude.',
      );
    }
    const decision = form.get('decision');
    if (decision !== 'approve' && decision !== 'deny') {
      return sendErrorPage(reply, 400, 'Invalid request', 'Choose Approve or Deny.');
    }
    // The owner's choice of profile and scope (policy layer). Checked before the request is used up, so a mistake
    // can be corrected with the browser's Back button.
    let profileId: string | undefined;
    // ADR 0033: the existing connections the owner left ticked. Only ids still offered for THIS application are kept
    // (a submitted id is never trusted); they are revoked later, when the code is exchanged, never now.
    let replaces: string[] = [];
    if (decision === 'approve' && s.profiles) {
      const client = s.store.getClient(pending.clientId);
      if (client) {
        const offered = new Set(
          s.profiles
            .existingConnections({
              clientId: client.clientId,
              kind: client.kind,
              redirectUri: pending.redirectUri,
            })
            .map((c) => c.id),
        );
        replaces = [...new Set(form.getAll('replace'))].filter((id) => offered.has(id));
      }
    }
    if (decision === 'approve' && s.profiles) {
      const choice = form.get('profile');
      const scope = form.get('scope');
      if (!choice || !scope) {
        return sendErrorPage(
          reply,
          400,
          'Choose a profile',
          'Choose a profile and a scope for this connection.',
        );
      }
      const newLabel = form.get('new_label');
      const newKind = form.get('new_kind');
      const confirmScopeChange = form.get('confirm_scope_change');
      const applied = s.profiles.apply({
        profileId: choice,
        scope,
        ...(newLabel !== undefined ? { newLabel } : {}),
        ...(newKind !== undefined ? { newKind } : {}),
        ...(confirmScopeChange !== undefined ? { confirmScopeChange } : {}),
      });
      if (!applied.ok && 'confirm' in applied) {
        // A change to an existing profile's scope: ask once more, with the warning, before anything changes. The
        // request is not used up; the confirmation form posts it again with the same CSRF token.
        s.event('consent.scope_change_confirm', {
          client_id: pending.clientId,
          profile_id: applied.confirm.profileId,
          from: applied.confirm.from,
          to: applied.confirm.to,
        });
        return sendHtml(
          reply,
          200,
          renderScopeConfirm({
            action: OAUTH_PATHS.consent,
            requestId,
            csrf: form.get('csrf_token') ?? '',
            redirectHost: displayHost(pending.redirectUri),
            ...applied.confirm,
            replace: replaces,
          }),
          [new URL(pending.redirectUri).origin],
        );
      }
      if (!applied.ok) return sendErrorPage(reply, 400, 'Choose a profile', applied.error);
      profileId = applied.profileId;
    }
    s.consents.delete(requestId);
    const back = (params: Record<string, string | undefined>) =>
      reply
        .header('cache-control', 'no-store')
        .redirect(
          redirectWith(pending.redirectUri, { ...params, state: pending.state, iss: config.issuer }),
          303,
        );
    if (decision === 'deny') {
      s.event('consent.denied', { client_id: pending.clientId });
      return back({ error: 'access_denied', error_description: 'The owner denied the request' });
    }
    const code = s.tokens.issueCode({
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      redirectUriProvided: pending.redirectUriProvided,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
      ...(profileId !== undefined ? { profileId } : {}),
      ...(replaces.length > 0 ? { replaces } : {}),
    });
    s.event('consent.granted', {
      client_id: pending.clientId,
      scope: pending.scopes.join(' '),
      redirect_host: displayHost(pending.redirectUri),
      ...(profileId !== undefined ? { profile_id: profileId } : {}),
      ...(replaces.length > 0 ? { replaces: replaces.length } : {}),
    });
    return back({ code });
  };

  app.get(OAUTH_PATHS.authorize, authorize);
  app.get(LEGACY_ALIASES.authorize, authorize);
  app.post(OAUTH_PATHS.consent, consent);
}
