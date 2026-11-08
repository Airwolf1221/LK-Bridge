import { createRequire } from 'node:module';
import { type JWK, compactVerify, decodeProtectedHeader, importJWK } from 'jose';
import type { AuthConfig } from '../config/auth.js';
import { cacheLifetimeSeconds, loggableValue } from './cimd.js';
import type { AuthEventLogger } from './events.js';
import {
  type AssertionAlg,
  JwksShapeError,
  type PublicJwk,
  isAssertionAlg,
  jwksUriProblem,
  keyFitsAlg,
  parseJwks,
} from './jwks.js';
import type { OutboundPortAllowlist } from './ports.js';
import { OAUTH_PATHS } from './routes/metadata.js';
import {
  type JsonFetcher,
  SafeFetchError,
  type SafeFetchOptions,
  createSafeJsonFetcher,
} from './safe-fetch.js';
import type { AuthStore, ClientRecord } from './store.js';
import { canonicaliseResource } from './url.js';

/**
 * `private_key_jwt` client authentication (RFC 7523 §2.2 and §3, OpenID Connect Core §9; ADR 0021). A client whose
 * metadata document says `token_endpoint_auth_method: "private_key_jwt"` (ChatGPT's does) proves its identity at the
 * token and revocation endpoints with a short-lived JWT signed by a key from its published key set.
 *
 * The key set comes from the document's `jwks_uri`, fetched through the same SSRF guard as the document itself
 * (https, port 443 unless allowlisted, public addresses only, no redirects, a deadline and a size cap), cached per its
 * HTTP headers within a maximum age, or from an inline `jwks`. Nothing here logs an assertion.
 */

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** The furthest ahead an assertion's `exp` may be (before the clock-skew allowance). */
export const MAX_ASSERTION_LIFETIME_SECONDS = 300;
/** Clock skew allowed on `exp`, `nbf` and `iat`. */
export const ASSERTION_CLOCK_SKEW_SECONDS = 60;
const MAX_ASSERTION_LENGTH = 8192;
/** Candidate keys tried when an assertion names no `kid`. */
const MAX_CANDIDATE_KEYS = 5;

export const JWKS_FETCH = {
  maxBytes: 64 * 1024,
  /** Freshness when the response says nothing (no Cache-Control or Expires). */
  defaultCacheSeconds: 300,
  /**
   * The shortest a fetched key set is kept, whatever its headers say, so that a `no-store` answer cannot turn every
   * (unauthenticated) token request into an outbound fetch. Rotation is still picked up through the unknown-kid refetch.
   */
  minCacheSeconds: 30,
  /** The longest a fetched key set is trusted, whatever its headers say, so a withdrawn key stops working. */
  maxCacheSeconds: 3600,
  /** An unknown `kid` refetches the key set at most this often per `jwks_uri`. */
  refetchIntervalSeconds: 60,
  /** After a failed fetch, requests fail with the same reason for this long instead of fetching again. */
  failureBackoffSeconds: 5,
} as const;

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
export const JWKS_USER_AGENT = `LK-Bridge/${pkg.version} (OAuth client key fetcher)`;

/** The production key-set fetcher: the SSRF-guarded fetcher with the key-set size cap, User-Agent and Accept. */
export function createJwksFetcher(
  o: {
    readonly timeoutMs: number;
    readonly allowedPorts?: OutboundPortAllowlist;
  } & Pick<SafeFetchOptions, 'resolve' | 'ca' | 'allowAddress'>,
): JsonFetcher {
  return createSafeJsonFetcher({
    ...o,
    maxBytes: JWKS_FETCH.maxBytes,
    userAgent: JWKS_USER_AGENT,
    accept: 'application/jwk-set+json, application/json',
  });
}

/** Why an assertion was refused. Logged as `reason` on `client.assertion_rejected`. */
export type AssertionFailure =
  | 'no_assertion'
  | 'wrong_assertion_type'
  | 'assertion_not_allowed'
  | 'malformed_assertion'
  | 'alg_not_allowed'
  | 'wrong_alg'
  | 'unknown_kid'
  | 'no_matching_key'
  | 'bad_signature'
  | 'wrong_iss'
  | 'wrong_sub'
  | 'wrong_aud'
  | 'no_exp'
  | 'expired'
  | 'exp_too_far'
  | 'not_yet_valid'
  | 'iat_in_future'
  | 'no_jti'
  | 'replayed_jti'
  | 'jwks_fetch_failed'
  | 'jwks_invalid'
  | 'no_keys_configured';

export type AssertionLogFields = Readonly<Record<string, string | number | boolean | null>>;

export class ClientAssertionError extends Error {
  constructor(
    readonly reason: AssertionFailure,
    message: string,
    /** Extra log fields: never the assertion, never a key. */
    readonly fields: AssertionLogFields = {},
  ) {
    super(message);
    this.name = 'ClientAssertionError';
  }
}

/** The key source and signing algorithm a `private_key_jwt` client registered, read from its stored document. */
export interface AssertionKeyConfig {
  readonly jwksUri: string | null;
  readonly jwks: PublicJwk[] | null;
  readonly signingAlg: AssertionAlg | null;
}

/** Reads (and re-checks) a client's key configuration from its stored metadata document. */
export function assertionKeyConfig(client: ClientRecord): AssertionKeyConfig {
  const m = client.metadata;
  const signingAlg = isAssertionAlg(m.token_endpoint_auth_signing_alg)
    ? m.token_endpoint_auth_signing_alg
    : null;
  if (typeof m.jwks_uri === 'string' && jwksUriProblem(m.jwks_uri) === null) {
    return { jwksUri: m.jwks_uri, jwks: null, signingAlg };
  }
  if (m.jwks !== undefined) {
    try {
      return { jwksUri: null, jwks: parseJwks(m.jwks), signingAlg };
    } catch {
      // Fall through: the stored document has no usable keys.
    }
  }
  throw new ClientAssertionError(
    'no_keys_configured',
    'the client is registered for private_key_jwt but its metadata names no usable jwks_uri or jwks',
  );
}

interface JwksEntry {
  readonly keys: PublicJwk[];
  readonly fetchedAt: number;
  readonly expiresAt: number;
}

/** Fetched key sets, keyed by `jwks_uri`, held in memory. Concurrent fetches of one URI share a request. */
export class JwksCache {
  private readonly entries = new Map<string, JwksEntry>();
  private readonly inflight = new Map<string, Promise<JwksEntry>>();
  private readonly failures = new Map<
    string,
    { readonly at: number; readonly error: ClientAssertionError }
  >();

  constructor(
    private readonly deps: {
      readonly fetchJson: JsonFetcher;
      readonly now: () => number;
      readonly event: AuthEventLogger;
    },
  ) {}

  /** The key set, from the cache while it is fresh. Throws {@link ClientAssertionError}. */
  async get(uri: string, clientId: string): Promise<JwksEntry> {
    const entry = this.entries.get(uri);
    if (entry && entry.expiresAt > this.deps.now()) return entry;
    return this.load(uri, clientId);
  }

  /**
   * Fetches the key set again because an assertion named a `kid` it does not contain (the client may have rotated
   * its keys). Returns undefined, fetching nothing, when the set was fetched less than the refetch interval ago.
   */
  async refetch(uri: string, clientId: string): Promise<JwksEntry | undefined> {
    const entry = this.entries.get(uri);
    if (entry && this.deps.now() - entry.fetchedAt < JWKS_FETCH.refetchIntervalSeconds) return undefined;
    return this.load(uri, clientId);
  }

  private load(uri: string, clientId: string): Promise<JwksEntry> {
    const existing = this.inflight.get(uri);
    if (existing) return existing;
    const p = this.fetchOnce(uri, clientId).finally(() => this.inflight.delete(uri));
    this.inflight.set(uri, p);
    return p;
  }

  private async fetchOnce(uri: string, clientId: string): Promise<JwksEntry> {
    const now = this.deps.now();
    const failed = this.failures.get(uri);
    if (failed && now - failed.at < JWKS_FETCH.failureBackoffSeconds) {
      throw new ClientAssertionError(failed.error.reason, failed.error.message, {
        ...failed.error.fields,
        backoff: true,
      });
    }
    try {
      let result;
      try {
        result = await this.deps.fetchJson(uri);
      } catch (err) {
        const fetchReason = err instanceof SafeFetchError ? err.reason : 'network';
        throw new ClientAssertionError(
          'jwks_fetch_failed',
          `the client's key set could not be fetched from its jwks_uri: ${(err as Error).message}`,
          { jwks_uri: uri.slice(0, 300), fetch_reason: fetchReason },
        );
      }
      let keys: PublicJwk[];
      try {
        keys = parseJwks(result.body);
      } catch (err) {
        if (!(err instanceof JwksShapeError)) throw err;
        throw new ClientAssertionError('jwks_invalid', `the client's key set is not usable: ${err.message}`, {
          jwks_uri: uri.slice(0, 300),
        });
      }
      const cacheSeconds = Math.max(
        JWKS_FETCH.minCacheSeconds,
        cacheLifetimeSeconds(
          result.headers,
          { defaultSeconds: JWKS_FETCH.defaultCacheSeconds, maxSeconds: JWKS_FETCH.maxCacheSeconds },
          now * 1000,
        ),
      );
      const entry = { keys, fetchedAt: now, expiresAt: now + cacheSeconds };
      this.entries.set(uri, entry);
      this.failures.delete(uri);
      this.deps.event('client.jwks_fetched', {
        client_id: clientId,
        jwks_uri: uri.slice(0, 300),
        keys: keys.length,
        kids: keys.map((k) => loggableValue(k.kid ?? '(none)')).join(' '),
        cache_seconds: cacheSeconds,
      });
      return entry;
    } catch (err) {
      if (err instanceof ClientAssertionError) this.failures.set(uri, { at: now, error: err });
      throw err;
    }
  }
}

export interface VerifiedAssertion {
  readonly kid: string | null;
  readonly alg: AssertionAlg;
  readonly keySource: 'jwks_uri' | 'jwks';
}

/** Verifies `private_key_jwt` client assertions (signature, claims, single use). */
export class ClientAssertionVerifier {
  private readonly audiences: ReadonlySet<string>;

  constructor(
    private readonly deps: {
      readonly config: AuthConfig;
      readonly store: AuthStore;
      readonly jwks: JwksCache;
      readonly now: () => number;
    },
  ) {
    const issuer = deps.config.issuer;
    // Either the issuer or the advertised token endpoint is accepted as `aud`, compared canonically.
    this.audiences = new Set(
      [issuer, `${issuer}${OAUTH_PATHS.token}`]
        .map((u) => canonicaliseResource(u))
        .filter((u): u is string => u !== undefined),
    );
  }

  /** Throws {@link ClientAssertionError} with the specific reason. Records the `jti` only on success. */
  async verify(client: ClientRecord, assertion: string): Promise<VerifiedAssertion> {
    const clientId = client.clientId;
    if (assertion.length > MAX_ASSERTION_LENGTH || assertion.split('.').length !== 3) {
      throw new ClientAssertionError('malformed_assertion', 'client_assertion is not a compact signed JWT');
    }
    let header: Record<string, unknown>;
    try {
      header = decodeProtectedHeader(assertion);
    } catch {
      throw new ClientAssertionError('malformed_assertion', 'client_assertion is not a compact signed JWT');
    }
    const alg = header.alg;
    const kid = typeof header.kid === 'string' ? header.kid : null;
    const algField = { alg: loggableValue(alg ?? null), kid: kid === null ? null : loggableValue(kid) };
    if (!isAssertionAlg(alg)) {
      throw new ClientAssertionError(
        'alg_not_allowed',
        'client_assertion must be signed with an asymmetric algorithm (RS*, PS* or ES*)',
        algField,
      );
    }
    const config = assertionKeyConfig(client);
    if (config.signingAlg !== null && alg !== config.signingAlg) {
      throw new ClientAssertionError(
        'wrong_alg',
        `client_assertion must be signed with ${config.signingAlg}, as the client's metadata declares`,
        { ...algField, declared_alg: config.signingAlg },
      );
    }

    // Keys: by kid when one is named, refetching the set once (rate-limited) when the kid is unknown.
    const keySource = config.jwksUri !== null ? 'jwks_uri' : 'jwks';
    let keys = config.jwks ?? (await this.deps.jwks.get(config.jwksUri as string, clientId)).keys;
    let refetched: 'yes' | 'rate_limited' | 'no' = 'no';
    if (kid !== null && !keys.some((k) => k.kid === kid) && config.jwksUri !== null) {
      const fresh = await this.deps.jwks.refetch(config.jwksUri, clientId);
      refetched = fresh ? 'yes' : 'rate_limited';
      if (fresh) keys = fresh.keys;
    }
    if (kid !== null && !keys.some((k) => k.kid === kid)) {
      throw new ClientAssertionError(
        'unknown_kid',
        "client_assertion names a kid that is not in the client's key set",
        {
          ...algField,
          refetched,
          known_kids: keys.map((k) => loggableValue(k.kid ?? '(none)')).join(' '),
        },
      );
    }
    const candidates = keys
      .filter((k) => (kid === null || k.kid === kid) && keyFitsAlg(k, alg))
      .slice(0, MAX_CANDIDATE_KEYS);
    if (candidates.length === 0) {
      throw new ClientAssertionError(
        'no_matching_key',
        `no key in the client's key set can verify ${alg}`,
        algField,
      );
    }

    let payload: Uint8Array | undefined;
    for (const jwk of candidates) {
      try {
        const key = await importJWK({ ...jwk } as JWK, alg);
        payload = (await compactVerify(assertion, key, { algorithms: [alg] })).payload;
        break;
      } catch {
        // Wrong key, bad signature, or a key jose will not use (an RSA modulus under 2048 bits): try the next.
      }
    }
    if (!payload) {
      throw new ClientAssertionError('bad_signature', 'client_assertion signature does not verify', algField);
    }

    let claims: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('not an object');
      claims = parsed as Record<string, unknown>;
    } catch {
      throw new ClientAssertionError(
        'malformed_assertion',
        'client_assertion claims are not a JSON object',
        algField,
      );
    }
    this.checkClaims(clientId, claims, algField);
    const exp = claims.exp as number;
    const jti = claims.jti as string;
    // Single use: kept in SQLite until the assertion could no longer be accepted, so a restart keeps the record.
    const now = this.deps.now();
    if (
      !this.deps.store.claimAssertionJti(clientId, jti, Math.ceil(exp) + ASSERTION_CLOCK_SKEW_SECONDS, now)
    ) {
      throw new ClientAssertionError(
        'replayed_jti',
        'client_assertion has already been used (jti seen before)',
        {
          ...algField,
          jti: loggableValue(jti),
        },
      );
    }
    return { kid, alg, keySource };
  }

  private checkClaims(clientId: string, claims: Record<string, unknown>, algField: AssertionLogFields): void {
    const fail = (reason: AssertionFailure, message: string, extra: AssertionLogFields = {}) =>
      new ClientAssertionError(reason, message, { ...algField, ...extra });
    if (claims.iss !== clientId) {
      throw fail('wrong_iss', 'client_assertion iss must be the client_id', {
        iss: loggableValue(claims.iss ?? null),
      });
    }
    if (claims.sub !== clientId) {
      throw fail('wrong_sub', 'client_assertion sub must be the client_id', {
        sub: loggableValue(claims.sub ?? null),
      });
    }
    const aud = Array.isArray(claims.aud) ? (claims.aud as unknown[]) : [claims.aud];
    if (!aud.some((a) => typeof a === 'string' && this.audiences.has(canonicaliseResource(a) ?? ''))) {
      throw fail('wrong_aud', "client_assertion aud must be this server's issuer or token endpoint", {
        aud: loggableValue(claims.aud ?? null),
      });
    }
    const now = this.deps.now();
    const skew = ASSERTION_CLOCK_SKEW_SECONDS;
    const exp = claims.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) {
      throw fail('no_exp', 'client_assertion must carry a numeric exp');
    }
    if (now > exp + skew) throw fail('expired', 'client_assertion has expired', { exp, now });
    if (exp > now + MAX_ASSERTION_LIFETIME_SECONDS + skew) {
      throw fail(
        'exp_too_far',
        `client_assertion exp is more than ${MAX_ASSERTION_LIFETIME_SECONDS} seconds ahead`,
        {
          exp,
          now,
        },
      );
    }
    if (claims.nbf !== undefined) {
      if (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf)) {
        throw fail('malformed_assertion', 'client_assertion nbf must be numeric');
      }
      if (claims.nbf > now + skew) {
        throw fail('not_yet_valid', 'client_assertion is not valid yet (nbf)', { nbf: claims.nbf, now });
      }
    }
    if (claims.iat !== undefined) {
      if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) {
        throw fail('malformed_assertion', 'client_assertion iat must be numeric');
      }
      if (claims.iat > now + skew) {
        throw fail('iat_in_future', 'client_assertion was issued in the future (iat)', {
          iat: claims.iat,
          now,
        });
      }
    }
    if (typeof claims.jti !== 'string' || claims.jti.length === 0 || claims.jti.length > 256) {
      throw fail('no_jti', 'client_assertion must carry a jti (1 to 256 characters)');
    }
  }
}
