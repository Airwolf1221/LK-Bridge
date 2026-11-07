/**
 * Canonical form of a resource URI (RFC 8707, MCP authorization): lowercase scheme and host, no
 * default port, no fragment, no trailing slash. Query strings are kept. Returns `undefined` for
 * anything that is not an absolute http(s) URL without credentials.
 */
export function canonicaliseResource(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password) return undefined;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/** Hostname for display, without IPv6 brackets. */
export function displayHost(uri: string): string {
  try {
    return new URL(uri).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return uri;
  }
}
