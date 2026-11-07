import * as z from 'zod';
import type { AuthConfig } from '../config/auth.js';
import { CimdError, type CimdFetcher, isCimdClientId } from './cimd.js';
import { hashSecret, randomToken, safeEqual } from './crypto.js';
import { OAuthError, invalidClient, invalidRequest } from './errors.js';
import type { AuthEventLogger } from './events.js';
import { isAllowedRedirectUri } from './redirect-uris.js';
import { SUPPORTED_SCOPES, parseScope } from './scopes.js';
import type { AuthStore, ClientRecord, TokenEndpointAuthMethod } from './store.js';

/** Client registration (RFC 7591) and client resolution (DCR ids and CIMD URLs). */

const AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'] as const;
const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

const registrationSchema = z
  .object({
    redirect_uris: z.array(z.string().max(2048)).min(1).max(10),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).max(5).optional(),
    response_types: z.array(z.string()).max(5).optional(),
    client_name: z.string().max(200).optional(),
    client_uri: z.string().max(2048).optional(),
    logo_uri: z.string().max(2048).optional(),
    tos_uri: z.string().max(2048).optional(),
    policy_uri: z.string().max(2048).optional(),
    scope: z.string().max(1000).optional(),
    contacts: z.array(z.string().max(320)).max(10).optional(),
    software_id: z.string().max(200).optional(),
    software_version: z.string().max(200).optional(),
  })
  .loose();

/** RFC 7591 §3.2.2 errors are answered with status 400. */
const registrationError = (error: 'invalid_redirect_uri' | 'invalid_client_metadata', d: string) =>
  new OAuthError(error, d, 400);

// eslint-disable-next-line no-control-regex
const stripControl = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();

export interface RegistrationResult {
  readonly client: ClientRecord;
  /** RFC 7591 §3.2.1 response body. Contains the client secret, shown once, for confidential clients. */
  readonly response: Record<string, unknown>;
}

export interface ClientCredentials {
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly usedBasic: boolean;
}

export class ClientService {
  constructor(
    private readonly deps: {
      readonly store: AuthStore;
      readonly config: AuthConfig;
      readonly cimd: CimdFetcher;
      readonly event: AuthEventLogger;
      readonly now: () => number;
    },
  ) {}

  /** RFC 7591 dynamic client registration. Throws {@link OAuthError}. */
  register(body: unknown): RegistrationResult {
    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) {
      const redirectIssue = parsed.error.issues.some((i) => i.path[0] === 'redirect_uris');
      throw redirectIssue
        ? registrationError('invalid_redirect_uri', 'redirect_uris must be a non-empty array of URIs')
        : registrationError('invalid_client_metadata', 'Client metadata is malformed');
    }
    const m = parsed.data;
    const redirectUris = [...new Set(m.redirect_uris)];
    for (const uri of redirectUris) {
      if (!isAllowedRedirectUri(uri, this.deps.config.extraRedirectUris)) {
        // Redirect URIs are not secrets. Logging the refused one tells the owner exactly what to
        // add to OAUTH_EXTRA_REDIRECT_URIS if a client starts using a new callback.
        this.deps.event(
          'client.registration_rejected',
          {
            error: 'invalid_redirect_uri',
            redirect_uri: uri.slice(0, 300),
            client_name: m.client_name ?? null,
          },
          'warn',
        );
        throw registrationError(
          'invalid_redirect_uri',
          'Redirect URI not accepted. Allowed: https://claude.ai/api/mcp/auth_callback, ' +
            'https://claude.com/api/mcp/auth_callback, https://chatgpt.com/connector_platform_oauth_redirect, ' +
            'https://chatgpt.com/connector/oauth/<id>, http://localhost[:port]/callback, ' +
            'http://127.0.0.1[:port]/callback, and any listed in OAUTH_EXTRA_REDIRECT_URIS',
        );
      }
    }
    // RFC 7591 §2: the default is client_secret_basic.
    const method = (m.token_endpoint_auth_method ?? 'client_secret_basic') as TokenEndpointAuthMethod;
    if (!(AUTH_METHODS as readonly string[]).includes(method)) {
      throw registrationError(
        'invalid_client_metadata',
        `token_endpoint_auth_method must be one of: ${AUTH_METHODS.join(', ')}`,
      );
    }
    // The server provisions both grants when none are requested (RFC 7591 §3.2.1 lets it).
    const grantTypes = [...new Set(m.grant_types ?? [...GRANT_TYPES])];
    if (grantTypes.some((g) => !(GRANT_TYPES as readonly string[]).includes(g))) {
      throw registrationError(
        'invalid_client_metadata',
        `grant_types may only contain: ${GRANT_TYPES.join(', ')}`,
      );
    }
    if (!grantTypes.includes('authorization_code')) {
      throw registrationError('invalid_client_metadata', 'grant_types must include authorization_code');
    }
    const responseTypes = [...new Set(m.response_types ?? ['code'])];
    if (responseTypes.length !== 1 || responseTypes[0] !== 'code') {
      throw registrationError('invalid_client_metadata', 'response_types must be ["code"]');
    }
    let scope: string | null = null;
    if (m.scope !== undefined) {
      try {
        scope = parseScope(m.scope)
          .filter((s) => SUPPORTED_SCOPES.includes(s))
          .join(' ');
      } catch {
        throw registrationError('invalid_client_metadata', 'scope is malformed');
      }
    }

    const now = this.deps.now();
    const clientId = `lkb_c_${randomToken(16)}`;
    const secret = method === 'none' ? undefined : `lkb_cs_${randomToken(32)}`;
    const clientName = m.client_name !== undefined ? stripControl(m.client_name) || null : null;
    const registered: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: now,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: method,
      grant_types: grantTypes,
      response_types: responseTypes,
      ...(clientName ? { client_name: clientName } : {}),
      ...(scope ? { scope } : {}),
      ...(m.client_uri ? { client_uri: m.client_uri } : {}),
      ...(m.logo_uri ? { logo_uri: m.logo_uri } : {}),
      ...(m.tos_uri ? { tos_uri: m.tos_uri } : {}),
      ...(m.policy_uri ? { policy_uri: m.policy_uri } : {}),
      ...(m.contacts ? { contacts: m.contacts } : {}),
      ...(m.software_id ? { software_id: m.software_id } : {}),
      ...(m.software_version ? { software_version: m.software_version } : {}),
    };
    const client: ClientRecord = {
      clientId,
      kind: 'dcr',
      clientName,
      redirectUris,
      grantTypes,
      responseTypes,
      tokenEndpointAuthMethod: method,
      clientSecretHash: secret ? hashSecret(secret) : null,
      scope,
      metadata: registered,
      createdAt: now,
      updatedAt: now,
      metadataExpiresAt: null,
      lastUsedAt: null,
    };
    this.deps.store.saveClient(client);
    this.deps.event('client.registered', {
      client_id: clientId,
      client_name: clientName,
      auth_method: method,
      redirect_hosts: redirectUris.map((u) => safeHost(u)).join(' '),
      redirect_uris: redirectUris.join(' '),
    });
    return {
      client,
      response: secret ? { ...registered, client_secret: secret, client_secret_expires_at: 0 } : registered,
    };
  }

  /** The stored registration for a CIMD client, if its document is still fresh. */
  freshCimd(clientId: string): ClientRecord | undefined {
    const c = this.deps.store.getClient(clientId);
    return c?.kind === 'cimd' && c.metadataExpiresAt !== null && c.metadataExpiresAt > this.deps.now()
      ? c
      : undefined;
  }

  /**
   * Resolves a client for the authorization endpoint. CIMD clients are fetched when missing or
   * stale. Throws {@link CimdError} when a document cannot be used; returns undefined when a
   * non-URL client id is unknown.
   */
  async resolveForAuthorization(clientId: string): Promise<ClientRecord | undefined> {
    if (!isCimdClientId(clientId)) return this.deps.store.getClient(clientId);
    const now = this.deps.now();
    const fresh = this.freshCimd(clientId);
    if (fresh) return fresh;
    const cached = this.deps.store.getClient(clientId);
    try {
      const { metadata, cacheSeconds } = await this.deps.cimd.fetch(clientId);
      const client: ClientRecord = {
        clientId,
        kind: 'cimd',
        clientName: metadata.clientName !== null ? stripControl(metadata.clientName) || null : null,
        redirectUris: metadata.redirectUris,
        grantTypes: metadata.grantTypes,
        responseTypes: metadata.responseTypes,
        tokenEndpointAuthMethod: 'none',
        clientSecretHash: null,
        scope: null,
        metadata: { ...metadata.document, declared_redirect_uris: metadata.declaredRedirectUris },
        createdAt: cached?.createdAt ?? now,
        updatedAt: now,
        metadataExpiresAt: now + cacheSeconds,
        lastUsedAt: cached?.lastUsedAt ?? null,
      };
      this.deps.store.saveClient(client);
      this.deps.event('client.metadata_fetched', {
        client_id: clientId,
        cache_seconds: cacheSeconds,
        redirect_hosts: client.redirectUris.map((u) => safeHost(u)).join(' '),
      });
      return client;
    } catch (err) {
      const message = err instanceof CimdError ? err.message : 'client metadata document could not be used';
      this.deps.event('client.metadata_rejected', { client_id: clientId, reason: message }, 'warn');
      throw err instanceof CimdError ? err : new CimdError(message);
    }
  }

  /**
   * Authenticates the client at the token or revocation endpoint (RFC 6749 §2.3).
   * Unknown or deleted clients get `401 invalid_client`, which makes Claude re-register.
   */
  authenticate(creds: ClientCredentials): ClientRecord {
    if (!creds.clientId) throw invalidClient('Client authentication is required', creds.usedBasic);
    const client = this.deps.store.getClient(creds.clientId);
    if (!client) throw invalidClient('Unknown client', creds.usedBasic);
    if (client.tokenEndpointAuthMethod === 'none') {
      if (creds.clientSecret !== undefined) {
        throw invalidClient(
          'This client is registered as a public client and must not send a secret',
          creds.usedBasic,
        );
      }
      return client;
    }
    if (creds.clientSecret === undefined || client.clientSecretHash === null) {
      throw invalidClient('Client secret is required', creds.usedBasic);
    }
    if (!safeEqual(hashSecret(creds.clientSecret), client.clientSecretHash)) {
      throw invalidClient('Client authentication failed', creds.usedBasic);
    }
    return client;
  }
}

/** Extracts client credentials from HTTP Basic and/or the form body (RFC 6749 §2.3.1). */
export function readClientCredentials(
  authorization: string | undefined,
  bodyClientId: string | undefined,
  bodySecret: string | undefined,
): ClientCredentials {
  if (authorization && /^basic\s/i.test(authorization)) {
    let decoded: string;
    try {
      decoded = Buffer.from(authorization.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
    } catch {
      throw invalidClient('Malformed Basic credentials', true);
    }
    const sep = decoded.indexOf(':');
    if (sep < 0) throw invalidClient('Malformed Basic credentials', true);
    let id: string;
    let secret: string;
    try {
      id = decodeURIComponent(decoded.slice(0, sep).replace(/\+/g, ' '));
      secret = decodeURIComponent(decoded.slice(sep + 1).replace(/\+/g, ' '));
    } catch {
      throw invalidClient('Malformed Basic credentials', true);
    }
    if (bodySecret !== undefined) throw invalidRequest('Use only one client authentication method');
    if (bodyClientId !== undefined && bodyClientId !== id) {
      throw invalidRequest('client_id does not match the Basic credentials');
    }
    return { clientId: id, clientSecret: secret, usedBasic: true };
  }
  return { clientId: bodyClientId, clientSecret: bodySecret, usedBasic: false };
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return '?';
  }
}
