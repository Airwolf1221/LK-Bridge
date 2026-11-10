import type { ClientRecord } from './store.js';

/**
 * "The same application" (hotfix, ADR 0033): which existing connections a new one may replace.
 *
 * - A Client ID Metadata Document client is an application: the same `client_id` (a URL the application publishes).
 * - Anything else (Dynamic Client Registration gives a NEW `client_id` on every registration) is the same application
 *   when its verified redirect origin matches: the origin of the redirect URI of THIS authorisation request, which the
 *   bridge has already checked against the client's registered URIs, compared with the origins the other client
 *   registered. A loopback address (Claude Code) has an ephemeral port, so there the scheme and host decide, as they do
 *   for the redirect rules themselves (RFC 8252 §7.3).
 * - The client's self-reported name never decides this (as in src/policy/consent.ts).
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** `https://claude.ai`, or `http://localhost` for any loopback port; undefined for an unparseable URI. */
export function redirectOriginKey(redirectUri: string): string | undefined {
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return `${u.protocol}//${host}`;
  return u.origin;
}

export interface ApplicationRef {
  readonly clientId: string;
  readonly kind: 'dcr' | 'cimd';
  /** The redirect URI of the authorisation request being approved or exchanged. */
  readonly redirectUri: string;
}

/** True when `other` (a registered client) is the same application as `app`. */
export function sameApplication(
  app: ApplicationRef,
  other: Pick<ClientRecord, 'clientId' | 'redirectUris'>,
): boolean {
  if (other.clientId === app.clientId) return true;
  if (app.kind === 'cimd') return false;
  const key = redirectOriginKey(app.redirectUri);
  if (key === undefined) return false;
  return other.redirectUris.some((u) => redirectOriginKey(u) === key);
}
