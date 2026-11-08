import * as z from 'zod';
import type { AuthConfig } from '../config/auth.js';
import { decodeJwt } from 'jose';
import {
  CLIENT_ASSERTION_TYPE,
  ClientAssertionError,
  type ClientAssertionVerifier,
} from './client-assertion.js';
import {
  CimdError,
  type CimdFetcher,
  SUPPORTED_GRANT_TYPES,
  isCimdClientId,
  loggableValue,
  partitionSupported,
} from './cimd.js';
import { hashSecret, randomToken, safeEqual } from './crypto.js';
import { OAuthError, invalidClient, invalidRequest } from './errors.js';
import type { AuthEventLogger } from './events.js';
import { isAllowedRedirectUri } from './redirect-uris.js';
import { SUPPORTED_SCOPES, parseScope } from './scopes.js';
import type { AuthStore, ClientRecord, TokenEndpointAuthMethod } from './store.js';

/** Client registration (RFC 7591) and client resolution (DCR ids and CIMD URLs). */

const AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'] as const;

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
  /** RFC 7521 §4.2 `client_assertion_type` and `client_assertion` (private_key_jwt), as sent. */
  readonly assertionType?: string | undefined;
  readonly assertion?: string | undefined;
}

/** Where a client authenticates; logged with every assertion failure. */
export type ClientAuthEndpoint = 'token' | 'revocation';

export class ClientService {
  constructor(
    private readonly deps: {
      readonly store: AuthStore;
      readonly config: AuthConfig;
      readonly cimd: CimdFetcher;
      readonly assertions: ClientAssertionVerifier;
      readonly event: AuthEventLogger;
      readonly now: () => number;
    },
  ) {}

  /** RFC 7591 dynamic client registration. Throws {@link OAuthError}. */
  register(body: unknown): RegistrationResult {
    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) {
      const redirectIssue = parsed.error.issues.find((i) => i.path[0] === 'redirect_uris');
      const issue = redirectIssue ?? parsed.error.issues[0];
      const top = issue?.path[0];
      const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const name = typeof record.client_name === 'string' ? record.client_name : null;
      const field = issue && issue.path.length > 0 ? issue.path.map(String).join('.') : '(body)';
      // Never log anything that might be a secret, or contact addresses, whatever a client sends.
      const value = typeof top === 'string' && !/secret|contacts/i.test(top) ? record[top] : undefined;
      throw redirectIssue
        ? this.refuse(
            'invalid_redirect_uri',
            'redirect_uris must be a non-empty array of URIs',
            field,
            value,
            name,
          )
        : this.refuse('invalid_client_metadata', 'Client metadata is malformed', field, value, name);
    }
    const m = parsed.data;
    const name = m.client_name ?? null;
    const redirectUris = [...new Set(m.redirect_uris)];
    for (const uri of redirectUris) {
      if (!isAllowedRedirectUri(uri, this.deps.config.extraRedirectUris)) {
        // Redirect URIs are not secrets. Logging the refused one tells the owner exactly what to
        // add to OAUTH_EXTRA_REDIRECT_URIS if a client starts using a new callback.
        this.deps.event(
          'client.registration_rejected',
          {
            error: 'invalid_redirect_uri',
            field: 'redirect_uris',
            redirect_uri: uri.slice(0, 300),
            client_name: name,
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
      throw this.refuse(
        'invalid_client_metadata',
        `token_endpoint_auth_method must be one of: ${AUTH_METHODS.join(', ')}`,
        'token_endpoint_auth_method',
        method,
        name,
      );
    }
    // The server provisions both grants when none are requested, and registers only the
    // supported ones among those requested (RFC 7591 §3.2.1 lets it replace requested values).
    // Unsupported grants, such as the JWT bearer grant claude.ai asks for, are dropped, and the
    // response says what was registered. Only a request without authorization_code is refused.
    const requestedGrants = m.grant_types ?? [...SUPPORTED_GRANT_TYPES];
    const { kept: grantTypes, ignored: ignoredGrantTypes } = partitionSupported(
      requestedGrants,
      SUPPORTED_GRANT_TYPES,
    );
    if (!grantTypes.includes('authorization_code')) {
      throw this.refuse(
        'invalid_client_metadata',
        'grant_types must include authorization_code',
        'grant_types',
        requestedGrants,
        name,
      );
    }
    const responseTypes = [...new Set(m.response_types ?? ['code'])];
    if (responseTypes.length !== 1 || responseTypes[0] !== 'code') {
      throw this.refuse(
        'invalid_client_metadata',
        'response_types must be ["code"]',
        'response_types',
        m.response_types,
        name,
      );
    }
    let scope: string | null = null;
    if (m.scope !== undefined) {
      try {
        scope = parseScope(m.scope)
          .filter((s) => SUPPORTED_SCOPES.includes(s))
          .join(' ');
      } catch {
        throw this.refuse('invalid_client_metadata', 'scope is malformed', 'scope', m.scope, name);
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
    if (ignoredGrantTypes.length > 0) {
      this.deps.event('client.grant_types_ignored', {
        client_id: clientId,
        kind: 'dcr',
        ignored_grant_types: ignoredGrantTypes.map((g) => loggableValue(g)).join(' '),
        grant_types: grantTypes.join(' '),
      });
    }
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

  /**
   * Logs a refused registration with the field and offending value, so that one log line says
   * what to fix, and returns the RFC 7591 error to throw.
   */
  private refuse(
    error: 'invalid_redirect_uri' | 'invalid_client_metadata',
    description: string,
    field: string,
    value: unknown,
    clientName: string | null,
  ): OAuthError {
    this.deps.event(
      'client.registration_rejected',
      {
        error,
        field,
        value: value === undefined ? null : loggableValue(value),
        reason: description,
        client_name: clientName,
      },
      'warn',
    );
    return registrationError(error, description);
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
        tokenEndpointAuthMethod: metadata.tokenEndpointAuthMethod,
        clientSecretHash: null,
        scope: null,
        metadata: { ...metadata.document, declared_redirect_uris: metadata.declaredRedirectUris },
        createdAt: cached?.createdAt ?? now,
        updatedAt: now,
        metadataExpiresAt: now + cacheSeconds,
        lastUsedAt: cached?.lastUsedAt ?? null,
      };
      this.deps.store.saveClient(client);
      if (metadata.ignoredGrantTypes.length > 0 || metadata.ignoredResponseTypes.length > 0) {
        this.deps.event('client.grant_types_ignored', {
          client_id: clientId,
          kind: 'cimd',
          ignored_grant_types: metadata.ignoredGrantTypes.map((g) => loggableValue(g)).join(' '),
          grant_types: metadata.grantTypes.join(' '),
          ...(metadata.ignoredResponseTypes.length > 0
            ? { ignored_response_types: metadata.ignoredResponseTypes.map((r) => loggableValue(r)).join(' ') }
            : {}),
        });
      }
      this.deps.event('client.metadata_fetched', {
        client_id: clientId,
        cache_seconds: cacheSeconds,
        redirect_hosts: client.redirectUris.map((u) => safeHost(u)).join(' '),
        auth_method: metadata.tokenEndpointAuthMethod,
        ...(metadata.tokenEndpointAuthMethod === 'private_key_jwt'
          ? {
              jwks_uri: metadata.jwksUri === null ? '(inline jwks)' : metadata.jwksUri.slice(0, 300),
              signing_alg: metadata.signingAlg,
            }
          : {}),
      });
      return client;
    } catch (err) {
      const refusal =
        err instanceof CimdError ? err : new CimdError('client metadata document could not be used');
      // One line says which client, why, and which field and value were at fault.
      this.deps.event(
        'client.metadata_rejected',
        { client_id: clientId, reason: refusal.message, field: refusal.field, value: refusal.value },
        'warn',
      );
      throw refusal;
    }
  }

  /**
   * Authenticates the client at the token or revocation endpoint (RFC 6749 §2.3, RFC 7523 §2.2).
   * Unknown or deleted clients get `401 invalid_client`, which makes Claude re-register.
   *
   * The method is fixed by the client's registration: a `none` client must send neither a secret nor an assertion;
   * a `private_key_jwt` client must send a valid assertion and nothing else; a secret client its secret. Every
   * assertion failure is logged (`client.assertion_rejected`) with its specific reason, never the assertion.
   */
  async authenticate(
    creds: ClientCredentials,
    endpoint: ClientAuthEndpoint = 'token',
  ): Promise<ClientRecord> {
    const sentAssertion = creds.assertion !== undefined || creds.assertionType !== undefined;
    let clientId = creds.clientId;
    if (!clientId && creds.assertion !== undefined) {
      // RFC 7521 §4.2: client_id may be left out when the assertion identifies the client. Its unverified `sub` only
      // picks the registration; verification then requires iss and sub to equal that client_id.
      try {
        const sub = decodeJwt(creds.assertion).sub;
        if (typeof sub === 'string' && sub.length <= 2048) clientId = sub;
      } catch {
        // Not a JWT: treated as no client_id below.
      }
    }
    if (!clientId) throw invalidClient('Client authentication is required', creds.usedBasic);
    const client = this.deps.store.getClient(clientId);
    if (!client) throw invalidClient('Unknown client', creds.usedBasic);
    const method = client.tokenEndpointAuthMethod;
    const refuse = (
      reason: string,
      message: string,
      fields: Record<string, string | number | boolean | null> = {},
    ) => {
      this.deps.event(
        'client.assertion_rejected',
        { client_id: client.clientId, endpoint, auth_method: method, reason, detail: message, ...fields },
        'warn',
      );
      return invalidClient(`Client authentication failed: ${message}`, creds.usedBasic);
    };

    if (method === 'private_key_jwt') {
      if (creds.assertion === undefined) {
        // Said in one line, so a client that turns up without an assertion is obvious in the log.
        const sent = creds.usedBasic
          ? 'HTTP Basic credentials'
          : creds.clientSecret !== undefined
            ? 'a client_secret'
            : creds.assertionType !== undefined
              ? 'client_assertion_type without client_assertion'
              : 'client_id only';
        throw refuse(
          'no_assertion',
          'this client is registered for private_key_jwt (its metadata document says so) and must send client_assertion; it sent ' +
            sent,
          { sent },
        );
      }
      if (creds.assertionType !== CLIENT_ASSERTION_TYPE) {
        throw refuse('wrong_assertion_type', `client_assertion_type must be ${CLIENT_ASSERTION_TYPE}`, {
          assertion_type: creds.assertionType === undefined ? null : loggableValue(creds.assertionType),
        });
      }
      if (creds.clientSecret !== undefined || creds.usedBasic) {
        throw refuse('secret_not_allowed', 'a private_key_jwt client must not also send a client secret');
      }
      try {
        const verified = await this.deps.assertions.verify(client, creds.assertion);
        this.deps.event('client.assertion_accepted', {
          client_id: client.clientId,
          endpoint,
          alg: verified.alg,
          kid: verified.kid === null ? null : loggableValue(verified.kid),
          key_source: verified.keySource,
        });
      } catch (err) {
        if (!(err instanceof ClientAssertionError)) throw err;
        throw refuse(err.reason, err.message, { ...err.fields });
      }
      return client;
    }

    if (sentAssertion) {
      // No method switching: a client registered for "none" (or a secret) cannot authenticate with an assertion.
      throw refuse(
        'assertion_not_allowed',
        `this client is registered for token_endpoint_auth_method "${method}" and must not send client_assertion`,
      );
    }
    if (method === 'none') {
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
  assertion: { readonly type: string | undefined; readonly value: string | undefined } = {
    type: undefined,
    value: undefined,
  },
): ClientCredentials {
  const assertionFields = { assertionType: assertion.type, assertion: assertion.value };
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
    return { clientId: id, clientSecret: secret, usedBasic: true, ...assertionFields };
  }
  return { clientId: bodyClientId, clientSecret: bodySecret, usedBasic: false, ...assertionFields };
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return '?';
  }
}
