/**
 * Outbound port policy (v1.0.1, review finding F-19). Every fetch the bridge itself starts to a host that is not
 * LegendKeeper (the CIMD client document, an image source URL and its redirects, the signed-URL upload PUT) may use
 * only port 443, unless `host:port` is listed in `OUTBOUND_EXTRA_PORTS_ALLOWLIST`. It sits beside the address policy
 * (`ip.ts`) inside each SSRF guard, so every hop of a redirect is checked the same way, and it is checked again by the
 * guarded request itself, before any DNS lookup or connection.
 *
 * Entries are exact: a host name or an IP literal (IPv6 in brackets), a colon and a port number, comma-separated, for
 * example `images.example.org:8443,[2001:db8::1]:8443`. No wildcards, no schemes, no paths. Host names are compared
 * after the WHATWG URL parser's normalisation (lower case, IDNA, IPv4 forms), exactly as the request URL is.
 */

/** The parsed allowlist: canonical `host:port` keys. Empty means "443 only". */
export type OutboundPortAllowlist = ReadonlySet<string>;

export const EMPTY_PORT_ALLOWLIST: OutboundPortAllowlist = new Set<string>();

/** Parses `OUTBOUND_EXTRA_PORTS_ALLOWLIST`. Throws an Error naming the bad entry (never anything secret). */
export function parseOutboundPortAllowlist(raw: string | undefined): OutboundPortAllowlist {
  const out = new Set<string>();
  if (raw === undefined) return out;
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    const bad = () =>
      new Error(
        `OUTBOUND_EXTRA_PORTS_ALLOWLIST: "${entry.slice(0, 100)}" must be host:port (a host name or IP, then a port 1-65535), with no scheme, path or wildcard`,
      );
    if (!/^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}$/.test(entry)) throw bad();
    let url: URL;
    try {
      url = new URL(`https://${entry}/`);
    } catch {
      throw bad();
    }
    const port = Number(entry.slice(entry.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535 || url.hostname === '') throw bad();
    out.add(key(url.hostname, port));
  }
  return out;
}

function key(hostname: string, port: number): string {
  return `${hostname.toLowerCase()}:${port}`;
}

/** The port an https URL connects to: its explicit port, else 443. */
export function effectivePort(url: URL): number {
  return url.port === '' ? 443 : Number(url.port);
}

/** True when the bridge may connect to this https URL's port: 443, or `host:port` listed in the allowlist. */
export function outboundPortAllowed(
  url: URL,
  allowlist: OutboundPortAllowlist = EMPTY_PORT_ALLOWLIST,
): boolean {
  const port = effectivePort(url);
  return port === 443 || allowlist.has(key(url.hostname, port));
}

/** The refusal message: names the port, never the URL (a signed URL must never reach a message). */
export function portRefusalMessage(url: URL): string {
  return `Only port 443 is allowed for outbound requests (port ${effectivePort(url)} is not in OUTBOUND_EXTRA_PORTS_ALLOWLIST)`;
}
