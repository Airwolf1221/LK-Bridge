/** Scope that grants use of the MCP tools. Every OAuth grant carries it. */
export const SCOPE_MCP = 'mcp';
/** OIDC-style scope Claude appends to obtain a refresh token. */
export const SCOPE_OFFLINE = 'offline_access';

/** Scopes the protected resource (`/mcp`) understands: advertised in protected-resource metadata. */
export const RESOURCE_SCOPES: readonly string[] = [SCOPE_MCP];
/** Scopes the authorization server can grant: advertised in authorization-server metadata. */
export const SUPPORTED_SCOPES: readonly string[] = [SCOPE_MCP, SCOPE_OFFLINE];

/** Consent-screen wording (British English). */
export const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  [SCOPE_MCP]:
    'Use the LK-Bridge tools: read and, when writes are enabled, change your LegendKeeper project.',
  [SCOPE_OFFLINE]: 'Stay connected: keep access after this window closes, using a rotating refresh token.',
};

/** RFC 6749 §3.3 scope-token: %x21 / %x23-5B / %x5D-7E. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

export class ScopeSyntaxError extends Error {}

/** Splits a `scope` parameter into unique tokens. Throws {@link ScopeSyntaxError} on bad syntax. */
export function parseScope(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const token of raw.split(' ')) {
    if (token === '') continue;
    if (!SCOPE_TOKEN.test(token)) throw new ScopeSyntaxError('scope contains invalid characters');
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * The scopes granted for an authorization request. Unknown scopes are ignored (RFC 6749 §3.3
 * lets the server ignore requested scope), and `mcp` is always included because a token
 * without it is useless at this bridge's only resource. The consent screen lists the result.
 */
export function grantableScopes(requested: readonly string[]): string[] {
  const known = SUPPORTED_SCOPES.filter((s) => requested.includes(s));
  return known.includes(SCOPE_MCP) ? known : [SCOPE_MCP, ...known];
}

export function formatScope(scopes: readonly string[]): string {
  return scopes.join(' ');
}
