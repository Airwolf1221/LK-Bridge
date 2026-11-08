import type { FastifyInstance } from 'fastify';
import type { AuthConfig } from '../../config/auth.js';
import { cors } from '../http.js';
import { ASSERTION_SIGNING_ALGS } from '../jwks.js';
import { RESOURCE_SCOPES, SUPPORTED_SCOPES } from '../scopes.js';

/** OAuth paths. The `/authorize`, `/token` and `/register` aliases serve 2025-03-26 clients. */
export const OAUTH_PATHS = {
  authorize: '/oauth/authorize',
  consent: '/oauth/consent',
  token: '/oauth/token',
  register: '/oauth/register',
  revoke: '/oauth/revoke',
  login: '/oauth/login',
  logout: '/oauth/logout',
} as const;

export const LEGACY_ALIASES = { authorize: '/authorize', token: '/token', register: '/register' } as const;

/** RFC 9728 protected-resource metadata for `/mcp`. */
export function protectedResourceMetadata(config: AuthConfig) {
  return {
    resource: config.mcpUrl,
    // Claude uses only the first entry, so this bridge is the one and only authorization server.
    authorization_servers: [config.issuer],
    scopes_supported: [...RESOURCE_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'LK-Bridge',
  };
}

/**
 * "none" stays first: Claude chooses its Client ID Metadata Document only when "none" is advertised. ChatGPT picks
 * from the intersection with its own list, and its document asks for private_key_jwt (ADR 0021).
 */
const AUTH_METHODS = ['none', 'private_key_jwt', 'client_secret_post', 'client_secret_basic'];

/** RFC 8414 authorization-server metadata. */
export function authorizationServerMetadata(config: AuthConfig) {
  const base = config.issuer;
  return {
    issuer: config.issuer,
    authorization_endpoint: `${base}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${base}${OAUTH_PATHS.token}`,
    registration_endpoint: `${base}${OAUTH_PATHS.register}`,
    revocation_endpoint: `${base}${OAUTH_PATHS.revoke}`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    token_endpoint_auth_signing_alg_values_supported: [...ASSERTION_SIGNING_ALGS],
    revocation_endpoint_auth_methods_supported: AUTH_METHODS,
    revocation_endpoint_auth_signing_alg_values_supported: [...ASSERTION_SIGNING_ALGS],
    scopes_supported: [...SUPPORTED_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

export function registerMetadataRoutes(app: FastifyInstance, config: AuthConfig): void {
  const prm = protectedResourceMetadata(config);
  const asm = authorizationServerMetadata(config);
  const json = (body: unknown) => (_req: unknown, reply: Parameters<typeof cors>[0]) =>
    cors(reply).header('cache-control', 'public, max-age=300').type('application/json').send(body);

  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    app.get(path, json(prm));
  }
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    app.get(path, json(asm));
  }
}
