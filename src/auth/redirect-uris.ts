/**
 * Redirect URI policy (PLAN §9.6, ADR 0008).
 *
 * - Exact-match hosted callbacks for Claude and ChatGPT.
 * - ChatGPT's per-connector callbacks, `https://chatgpt.com/connector/oauth/<id>`.
 * - RFC 8252 loopback callbacks where only the port may vary. Claude Code's Client ID Metadata
 *   Document declares `http://localhost/callback` and `http://127.0.0.1/callback` and then uses an
 *   ephemeral port, so both hostnames are matched with the port ignored.
 * - Exact URIs from `OAUTH_EXTRA_REDIRECT_URIS`.
 * A client's own registered or declared URIs must also match the requested one exactly.
 */

export const HOSTED_CALLBACKS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
];

/** Hosted callbacks with a variable final segment. The dots are literal. */
export const HOSTED_CALLBACK_PATTERNS: readonly RegExp[] = [
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/,
];

export const LOOPBACK_CALLBACKS: readonly string[] = [
  'http://localhost/callback',
  'http://127.0.0.1/callback',
];

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

interface LoopbackParts {
  readonly hostname: string;
  readonly path: string;
  readonly search: string;
}

/** Parses `uri` as an RFC 8252 loopback redirect (`http://localhost|127.0.0.1[:port]/...`). */
function loopbackParts(uri: string): LoopbackParts | undefined {
  if (uri.includes('#')) return undefined;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' || u.username || u.password) return undefined;
  if (!LOOPBACK_HOSTNAMES.has(u.hostname)) return undefined;
  // Reject anything the URL parser had to normalise, so string and parsed forms agree.
  const reconstructed = `http://${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}${u.search}`;
  if (reconstructed !== uri) return undefined;
  return { hostname: u.hostname, path: u.pathname, search: u.search };
}

export function isLoopbackRedirect(uri: string): boolean {
  return loopbackParts(uri) !== undefined;
}

/**
 * Whether `requested` matches `registered`: exact string equality, or for loopback URIs equality
 * of everything except the port (RFC 8252 §7.3).
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  const a = loopbackParts(requested);
  const b = loopbackParts(registered);
  return (
    a !== undefined &&
    b !== undefined &&
    a.hostname === b.hostname &&
    a.path === b.path &&
    a.search === b.search
  );
}

/** Whether the bridge accepts `uri` at all, for any client. */
export function isAllowedRedirectUri(uri: string, extra: readonly string[] = []): boolean {
  if (uri.length > 2048 || uri.includes('#')) return false;
  if (HOSTED_CALLBACKS.includes(uri)) return true;
  if (HOSTED_CALLBACK_PATTERNS.some((re) => re.test(uri))) return true;
  if (LOOPBACK_CALLBACKS.some((allowed) => redirectUriMatches(uri, allowed))) return true;
  return extra.some((allowed) => redirectUriMatches(uri, allowed));
}

/** Finds the registered URI that `requested` matches, or `undefined`. */
export function findRegisteredRedirect(requested: string, registered: readonly string[]): string | undefined {
  return registered.find((r) => redirectUriMatches(requested, r));
}
