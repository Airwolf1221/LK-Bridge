/**
 * ChatGPT's Client ID Metadata Document, verbatim as fetched from https://chatgpt.com/oauth/client.json by the live
 * bridge (8 November 2026). It authenticates at the token endpoint with private_key_jwt (RFC 7523), signed RS256, with
 * its keys at `jwks_uri`.
 *
 * `token_endpoint_auth_methods_supported` is not a client metadata field (it is an authorization-server metadata name);
 * the bridge ignores it, and enforces `token_endpoint_auth_method` alone (ADR 0021).
 */

export const CHATGPT_CIMD = 'https://chatgpt.com/oauth/client.json';
export const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

export const CHATGPT_DOC = {
  client_id: CHATGPT_CIMD,
  client_uri: 'https://chatgpt.com/',
  redirect_uris: [CHATGPT_REDIRECT],
  token_endpoint_auth_method: 'private_key_jwt',
  token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  client_name: 'ChatGPT',
  logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
  token_endpoint_auth_signing_alg: 'RS256',
  jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
} as const;

/** The same document shape, with `client_id` and `jwks_uri` replaced (for a local key-set server). */
export function chatgptDoc(clientId: string, jwksUri: string): Record<string, unknown> {
  return { ...structuredClone(CHATGPT_DOC), client_id: clientId, jwks_uri: jwksUri };
}
