import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readClientCredentials } from '../clients.js';
import { OAuthError, invalidRequest, unauthorizedClient, unsupportedGrantType } from '../errors.js';
import { FormBody } from '../form.js';
import { clientIp, cors, sendOAuthError } from '../http.js';
import type { AuthServices } from '../services.js';
import { LEGACY_ALIASES, OAUTH_PATHS } from './metadata.js';

/** Token (RFC 6749 §3.2), revocation (RFC 7009) and dynamic registration (RFC 7591) endpoints. */

function requireForm(req: FastifyRequest): FormBody {
  if (!(req.body instanceof FormBody)) {
    throw invalidRequest('Content-Type must be application/x-www-form-urlencoded');
  }
  const dup = req.body.duplicates(['resource']);
  if (dup.length > 0) throw invalidRequest(`Parameter repeated: ${dup.join(', ')}`);
  return req.body;
}

/** Client credentials from HTTP Basic, the form's secret, or the form's private_key_jwt assertion. */
function credentials(req: FastifyRequest, form: FormBody) {
  return readClientCredentials(req.headers.authorization, form.get('client_id'), form.get('client_secret'), {
    type: form.get('client_assertion_type'),
    value: form.get('client_assertion'),
  });
}

export function registerOAuthRoutes(app: FastifyInstance, s: AuthServices): void {
  const token = async (req: FastifyRequest, reply: FastifyReply) => {
    cors(reply);
    let clientId: string | undefined;
    let grantType: string | undefined;
    try {
      const form = requireForm(req);
      grantType = form.get('grant_type');
      if (!grantType) throw invalidRequest('grant_type is required');
      if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
        throw unsupportedGrantType('Supported grant types: authorization_code, refresh_token');
      }
      const client = await s.clients.authenticate(credentials(req, form), 'token');
      clientId = client.clientId;
      if (!client.grantTypes.includes(grantType)) {
        throw unauthorizedClient(`This client is not registered for the ${grantType} grant`);
      }
      const resources = form.getAll('resource');
      const body =
        grantType === 'authorization_code'
          ? await s.tokens.exchangeCode(client, {
              code: form.get('code'),
              redirectUri: form.get('redirect_uri'),
              codeVerifier: form.get('code_verifier'),
              resources,
            })
          : await s.tokens.refresh(client, {
              refreshToken: form.get('refresh_token'),
              scope: form.get('scope'),
              resources,
            });
      return reply
        .code(200)
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .type('application/json')
        .send(body);
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      s.event(
        'token.rejected',
        { grant_type: grantType ?? null, client_id: clientId ?? null, error: err.error, ip: clientIp(req) },
        'warn',
      );
      return sendOAuthError(reply, err);
    }
  };

  const revoke = async (req: FastifyRequest, reply: FastifyReply) => {
    cors(reply);
    try {
      const form = requireForm(req);
      const value = form.get('token');
      if (!value) throw invalidRequest('token is required');
      const client = await s.clients.authenticate(credentials(req, form), 'revocation');
      await s.tokens.revoke(client, value);
      return reply.code(200).header('cache-control', 'no-store').send();
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      return sendOAuthError(reply, err);
    }
  };

  const register = (req: FastifyRequest, reply: FastifyReply) => {
    cors(reply);
    const ip = clientIp(req);
    const wait = s.registrationLimiter.retryAfterMs(ip);
    if (wait > 0) {
      reply.header('retry-after', String(Math.ceil(wait / 1000)));
      return sendOAuthError(
        reply,
        new OAuthError('invalid_request', 'Too many registrations; try again later', 429),
      );
    }
    s.registrationLimiter.hit(ip);
    try {
      const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
      if (
        type !== 'application/json' ||
        typeof req.body !== 'object' ||
        req.body === null ||
        Array.isArray(req.body)
      ) {
        throw new OAuthError(
          'invalid_client_metadata',
          'The request body must be a JSON object (application/json)',
        );
      }
      const { response } = s.clients.register(req.body);
      return reply.code(201).header('cache-control', 'no-store').type('application/json').send(response);
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      if (err.error !== 'invalid_redirect_uri') {
        s.event('client.registration_rejected', { error: err.error, ip }, 'warn');
      }
      return sendOAuthError(reply, err);
    }
  };

  const preflight = (_req: FastifyRequest, reply: FastifyReply) => cors(reply).code(204).send();

  for (const path of [OAUTH_PATHS.token, LEGACY_ALIASES.token]) {
    app.post(path, token);
    app.options(path, preflight);
  }
  for (const path of [OAUTH_PATHS.register, LEGACY_ALIASES.register]) {
    app.post(path, { bodyLimit: 16 * 1024 }, register);
    app.options(path, preflight);
  }
  app.post(OAUTH_PATHS.revoke, revoke);
  app.options(OAUTH_PATHS.revoke, preflight);
  for (const path of [
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
  ]) {
    app.options(path, preflight);
  }
}
