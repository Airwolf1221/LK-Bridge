import * as z from 'zod';
import { isAllowedRedirectUri } from './redirect-uris.js';
import { type JsonFetcher, SafeFetchError } from './safe-fetch.js';

/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document, MCP 2025-11-25).
 * The `client_id` is an https URL; the bridge fetches it, checks that the document's own
 * `client_id` is the identical string, and validates its redirect URIs against the bridge policy.
 */

/** The longest offending value a refusal carries into the log. */
const MAX_LOGGED_VALUE = 300;

/** A JSON rendering of an offending value, cut to a length that is safe to log. */
export function loggableValue(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > MAX_LOGGED_VALUE ? `${text.slice(0, MAX_LOGGED_VALUE)}…` : text;
}

export class CimdError extends Error {
  /**
   * The document field (or `client_id` URL) that caused the refusal, and its offending value as
   * logged. Neither is shown to the user. A secret's value is never kept.
   */
  readonly field: string | null;
  readonly value: string | null;

  constructor(message: string, detail: { readonly field: string; readonly value?: unknown } | null = null) {
    super(message);
    this.name = 'CimdError';
    this.field = detail?.field ?? null;
    this.value = detail && 'value' in detail ? loggableValue(detail.value) : null;
  }
}

/** Whether a `client_id` should be treated as a metadata document URL. */
export function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith('https://');
}

/** Validates the URL form of a CIMD `client_id`. Throws {@link CimdError}. */
export function validateCimdUrl(clientId: string): URL {
  const bad = (message: string) => new CimdError(message, { field: 'client_id', value: clientId });
  if (clientId.length > 2048) throw bad('client_id URL is too long');
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw bad('client_id is not a valid URL');
  }
  if (url.protocol !== 'https:') throw bad('client_id URL must use https');
  if (url.username || url.password) throw bad('client_id URL must not contain credentials');
  if (clientId.includes('#')) throw bad('client_id URL must not contain a fragment');
  if (clientId.includes('?')) throw bad('client_id URL must not contain a query string');
  if (url.pathname === '/' || url.pathname === '') throw bad('client_id URL must contain a path');
  const rawPath = clientId.replace(/^https:\/\/[^/]*/i, '');
  if (rawPath.split('/').some((seg) => /^(?:\.|%2e){1,2}$/i.test(seg))) {
    throw bad('client_id URL must not contain dot segments');
  }
  return url;
}

const authMethods = ['none'] as const;

/**
 * The grants the bridge issues. A document may list others (claude.ai's lists the JWT bearer grant
 * for Enterprise Managed Auth); they are ignored, never issued, and the token endpoint refuses them.
 */
export const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
const SUPPORTED_RESPONSE_TYPES = ['code'] as const;

const documentSchema = z
  .object({
    client_id: z.string(),
    client_name: z.string().max(200).optional(),
    client_uri: z.string().max(2048).optional(),
    logo_uri: z.string().max(2048).optional(),
    redirect_uris: z.array(z.string().max(2048)).min(1).max(20),
    grant_types: z
      .array(z.string())
      .optional()
      .default([...SUPPORTED_GRANT_TYPES]),
    response_types: z
      .array(z.string())
      .optional()
      .default([...SUPPORTED_RESPONSE_TYPES]),
    token_endpoint_auth_method: z.string().optional().default('none'),
    scope: z.string().max(1000).optional(),
  })
  .loose();

export interface CimdMetadata {
  readonly clientName: string | null;
  /** Redirect URIs from the document that the bridge's policy allows. */
  readonly redirectUris: string[];
  readonly declaredRedirectUris: string[];
  /** The document's grant types that the bridge supports; always includes `authorization_code`. */
  readonly grantTypes: string[];
  /** Grant types the document lists that the bridge does not support, and so ignores. */
  readonly ignoredGrantTypes: string[];
  readonly responseTypes: string[];
  /** Response types the document lists other than `code`, which are ignored. */
  readonly ignoredResponseTypes: string[];
  readonly tokenEndpointAuthMethod: (typeof authMethods)[number];
  readonly document: Record<string, unknown>;
}

/** Splits requested values into those the bridge supports and those it ignores, keeping order. */
export function partitionSupported(
  requested: readonly string[],
  supported: readonly string[],
): { readonly kept: string[]; readonly ignored: string[] } {
  const unique = [...new Set(requested)];
  return {
    kept: unique.filter((v) => supported.includes(v)),
    ignored: unique.filter((v) => !supported.includes(v)),
  };
}

/** Validates a fetched document for `clientId`. Throws {@link CimdError}. */
export function validateCimdDocument(
  clientId: string,
  body: unknown,
  extraRedirectUris: readonly string[],
): CimdMetadata {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new CimdError('client metadata document must be a JSON object', {
      field: '(document)',
      value: Array.isArray(body) ? 'array' : body === null ? 'null' : typeof body,
    });
  }
  const record = body as Record<string, unknown>;
  for (const field of ['client_secret', 'client_secret_expires_at']) {
    // The field name alone is logged: a secret's value must never reach the log.
    if (field in record) {
      throw new CimdError('client metadata document must not contain a client secret', { field });
    }
  }
  const parsed = documentSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const top = issue?.path[0];
    const field = issue && issue.path.length > 0 ? issue.path.map(String).join('.') : '(document)';
    throw new CimdError(
      'client metadata document is malformed',
      typeof top === 'string' ? { field, value: record[top] } : { field },
    );
  }
  const doc = parsed.data;
  if (doc.client_id !== clientId) {
    throw new CimdError('client metadata document client_id does not match the URL it was fetched from', {
      field: 'client_id',
      value: doc.client_id,
    });
  }
  if (!(authMethods as readonly string[]).includes(doc.token_endpoint_auth_method)) {
    throw new CimdError('client metadata document must use token_endpoint_auth_method "none"', {
      field: 'token_endpoint_auth_method',
      value: doc.token_endpoint_auth_method,
    });
  }
  const grants = partitionSupported(doc.grant_types, SUPPORTED_GRANT_TYPES);
  if (!grants.kept.includes('authorization_code')) {
    throw new CimdError('client metadata document must allow the authorization_code grant', {
      field: 'grant_types',
      value: doc.grant_types,
    });
  }
  const responses = partitionSupported(doc.response_types, SUPPORTED_RESPONSE_TYPES);
  if (!responses.kept.includes('code')) {
    throw new CimdError('client metadata document must allow response type "code"', {
      field: 'response_types',
      value: doc.response_types,
    });
  }
  const declared = [...new Set(doc.redirect_uris)];
  const allowed = declared.filter((u) => isAllowedRedirectUri(u, extraRedirectUris));
  if (allowed.length === 0) {
    throw new CimdError('client metadata document lists no redirect URI that this bridge accepts', {
      field: 'redirect_uris',
      value: declared,
    });
  }
  return {
    clientName: doc.client_name ?? null,
    redirectUris: allowed,
    declaredRedirectUris: declared,
    grantTypes: grants.kept,
    ignoredGrantTypes: grants.ignored,
    responseTypes: responses.kept,
    ignoredResponseTypes: responses.ignored,
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
      throw new CimdError(`client metadata document could not be fetched: ${(err as Error).message}`, {
        field: '(fetch)',
        value: err instanceof SafeFetchError ? err.reason : (err as Error).name,
      });
    }
    const metadata = validateCimdDocument(clientId, result.body, this.options.extraRedirectUris);
    const cacheSeconds = cacheLifetimeSeconds(result.headers, {
      defaultSeconds: this.options.defaultCacheSeconds,
      maxSeconds: this.options.maxCacheSeconds,
    });
    return { metadata, cacheSeconds };
  }
}
