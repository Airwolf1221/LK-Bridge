import * as z from 'zod';
import { isAllowedRedirectUri } from './redirect-uris.js';
import type { JsonFetcher } from './safe-fetch.js';

/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document, MCP 2025-11-25).
 * The `client_id` is an https URL; the bridge fetches it, checks that the document's own
 * `client_id` is the identical string, and validates its redirect URIs against the bridge policy.
 */

export class CimdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CimdError';
  }
}

/** Whether a `client_id` should be treated as a metadata document URL. */
export function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith('https://');
}

/** Validates the URL form of a CIMD `client_id`. Throws {@link CimdError}. */
export function validateCimdUrl(clientId: string): URL {
  if (clientId.length > 2048) throw new CimdError('client_id URL is too long');
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new CimdError('client_id is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new CimdError('client_id URL must use https');
  if (url.username || url.password) throw new CimdError('client_id URL must not contain credentials');
  if (clientId.includes('#')) throw new CimdError('client_id URL must not contain a fragment');
  if (clientId.includes('?')) throw new CimdError('client_id URL must not contain a query string');
  if (url.pathname === '/' || url.pathname === '') throw new CimdError('client_id URL must contain a path');
  const rawPath = clientId.replace(/^https:\/\/[^/]*/i, '');
  if (rawPath.split('/').some((seg) => /^(?:\.|%2e){1,2}$/i.test(seg))) {
    throw new CimdError('client_id URL must not contain dot segments');
  }
  return url;
}

const authMethods = ['none'] as const;

const documentSchema = z
  .object({
    client_id: z.string(),
    client_name: z.string().max(200).optional(),
    client_uri: z.string().max(2048).optional(),
    logo_uri: z.string().max(2048).optional(),
    redirect_uris: z.array(z.string().max(2048)).min(1).max(20),
    grant_types: z.array(z.string()).optional().default(['authorization_code', 'refresh_token']),
    response_types: z.array(z.string()).optional().default(['code']),
    token_endpoint_auth_method: z.string().optional().default('none'),
    scope: z.string().max(1000).optional(),
  })
  .loose();

export interface CimdMetadata {
  readonly clientName: string | null;
  /** Redirect URIs from the document that the bridge's policy allows. */
  readonly redirectUris: string[];
  readonly declaredRedirectUris: string[];
  readonly grantTypes: string[];
  readonly responseTypes: string[];
  readonly tokenEndpointAuthMethod: (typeof authMethods)[number];
  readonly document: Record<string, unknown>;
}

/** Validates a fetched document for `clientId`. Throws {@link CimdError}. */
export function validateCimdDocument(
  clientId: string,
  body: unknown,
  extraRedirectUris: readonly string[],
): CimdMetadata {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new CimdError('client metadata document must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  if ('client_secret' in record || 'client_secret_expires_at' in record) {
    throw new CimdError('client metadata document must not contain a client secret');
  }
  const parsed = documentSchema.safeParse(body);
  if (!parsed.success) throw new CimdError('client metadata document is malformed');
  const doc = parsed.data;
  if (doc.client_id !== clientId) {
    throw new CimdError('client metadata document client_id does not match the URL it was fetched from');
  }
  if (!(authMethods as readonly string[]).includes(doc.token_endpoint_auth_method)) {
    throw new CimdError('client metadata document must use token_endpoint_auth_method "none"');
  }
  const grantTypes = [...new Set(doc.grant_types)];
  if (!grantTypes.includes('authorization_code')) {
    throw new CimdError('client metadata document must allow the authorization_code grant');
  }
  if (grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    throw new CimdError('client metadata document requests an unsupported grant type');
  }
  const responseTypes = [...new Set(doc.response_types)];
  if (responseTypes.length !== 1 || responseTypes[0] !== 'code') {
    throw new CimdError('client metadata document must use response_types ["code"]');
  }
  const declared = [...new Set(doc.redirect_uris)];
  const allowed = declared.filter((u) => isAllowedRedirectUri(u, extraRedirectUris));
  if (allowed.length === 0) {
    throw new CimdError('client metadata document lists no redirect URI that this bridge accepts');
  }
  return {
    clientName: doc.client_name ?? null,
    redirectUris: allowed,
    declaredRedirectUris: declared,
    grantTypes,
    responseTypes,
    tokenEndpointAuthMethod: 'none',
    document: record,
  };
}

/**
 * Freshness lifetime in seconds from response headers (RFC 9111, private-cache view):
 * `no-store`/`no-cache` → 0, `max-age` (minus `Age`), else `Expires - Date`, else the default.
 * Clamped to `[0, max]`.
 */
export function cacheLifetimeSeconds(
  headers: Readonly<Record<string, string | undefined>>,
  defaults: { readonly defaultSeconds: number; readonly maxSeconds: number },
  nowMs: number = Date.now(),
): number {
  const clamp = (n: number) => Math.max(0, Math.min(defaults.maxSeconds, Math.floor(n)));
  const cc = (headers['cache-control'] ?? '').toLowerCase();
  const directives = new Map<string, string | true>();
  for (const part of cc.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k) directives.set(k.trim(), v === undefined ? true : v.trim().replace(/^"|"$/g, ''));
  }
  if (directives.has('no-store') || directives.has('no-cache')) return 0;
  const maxAge = directives.get('max-age');
  if (typeof maxAge === 'string' && /^\d+$/.test(maxAge)) {
    const age = Number(headers.age ?? '0');
    return clamp(Number(maxAge) - (Number.isFinite(age) ? age : 0));
  }
  if (headers.expires !== undefined) {
    const expires = Date.parse(headers.expires);
    if (Number.isNaN(expires)) return 0; // RFC 9111 §5.3: invalid Expires means already expired
    const date = headers.date !== undefined ? Date.parse(headers.date) : NaN;
    return clamp((expires - (Number.isNaN(date) ? nowMs : date)) / 1000);
  }
  return clamp(defaults.defaultSeconds);
}

export interface FetchedCimd {
  readonly metadata: CimdMetadata;
  readonly cacheSeconds: number;
}

/** Fetches and validates a CIMD, deduplicating concurrent fetches of the same URL. */
export class CimdFetcher {
  private readonly inflight = new Map<string, Promise<FetchedCimd>>();

  constructor(
    private readonly fetchJson: JsonFetcher,
    private readonly options: {
      readonly extraRedirectUris: readonly string[];
      readonly defaultCacheSeconds: number;
      readonly maxCacheSeconds: number;
    },
  ) {}

  fetch(clientId: string): Promise<FetchedCimd> {
    const existing = this.inflight.get(clientId);
    if (existing) return existing;
    const p = this.load(clientId).finally(() => this.inflight.delete(clientId));
    this.inflight.set(clientId, p);
    return p;
  }

  private async load(clientId: string): Promise<FetchedCimd> {
    validateCimdUrl(clientId);
    let result;
    try {
      result = await this.fetchJson(clientId);
    } catch (err) {
      throw new CimdError(`client metadata document could not be fetched: ${(err as Error).message}`);
    }
    const metadata = validateCimdDocument(clientId, result.body, this.options.extraRedirectUris);
    const cacheSeconds = cacheLifetimeSeconds(result.headers, {
      defaultSeconds: this.options.defaultCacheSeconds,
      maxSeconds: this.options.maxCacheSeconds,
    });
    return { metadata, cacheSeconds };
  }
}
