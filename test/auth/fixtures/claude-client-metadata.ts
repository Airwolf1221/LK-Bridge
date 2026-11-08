/**
 * Claude's published Client ID Metadata Documents, verbatim (fetched 8 November 2026).
 *
 * claude.ai's custom connectors use the first ("Use Claude's published identity"). It lists the
 * JWT bearer grant (RFC 7523) for Enterprise Managed Auth, which the bridge does not issue and
 * must ignore rather than refuse. Claude Code's lists only the two grants the bridge supports.
 */

export const CLAUDE_AI_CIMD = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

export const CLAUDE_AI_DOC = {
  client_id: CLAUDE_AI_CIMD,
  client_name: 'Claude',
  client_uri: 'https://claude.ai',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  grant_types: ['authorization_code', 'refresh_token', JWT_BEARER_GRANT],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
} as const;

export const CLAUDE_CODE_CIMD = 'https://claude.ai/oauth/claude-code-client-metadata';

export const CLAUDE_CODE_DOC = {
  client_id: CLAUDE_CODE_CIMD,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
} as const;
