import type { FastifyBaseLogger } from 'fastify';
import type { AuthConfig } from '../config/auth.js';
import type { Db } from '../db/open.js';
import { BearerGuard } from './bearer.js';
import { CimdFetcher } from './cimd.js';
import { ClientAssertionVerifier, JwksCache, createJwksFetcher } from './client-assertion.js';
import { ClientService } from './clients.js';
import { OwnerCredentials } from './credentials.js';
import type { SecretStore } from '../secrets/store.js';
import { type KeyRing, deriveKeys, hashSecret, randomToken } from './crypto.js';
import { type AuthEventLogger, createAuthEventLogger } from './events.js';
import { type LoginLimits, OwnerAuth } from './owner.js';
import { PatService } from './pats.js';
import { SlidingWindowLimiter } from './rate-limit.js';
import { type JsonFetcher, createSafeJsonFetcher } from './safe-fetch.js';
import { AuthStore } from './store.js';
import { TokenService } from './tokens.js';

/** An authorization request waiting for the owner's decision. Held in memory only. */
export interface PendingConsent {
  readonly id: string;
  readonly sessionHash: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly redirectUriProvided: boolean;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly state: string | undefined;
  readonly expiresAt: number;
}

export class PendingConsents {
  private readonly items = new Map<string, PendingConsent>();

  constructor(
    private readonly ttlSeconds: number,
    private readonly now: () => number,
  ) {}

  create(p: Omit<PendingConsent, 'id' | 'expiresAt'>): PendingConsent {
    this.sweep();
    if (this.items.size >= 1000) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    const item = { ...p, id: randomToken(18), expiresAt: this.now() + this.ttlSeconds };
    this.items.set(item.id, item);
    return item;
  }

  get(id: string | undefined): PendingConsent | undefined {
    if (!id) return undefined;
    const item = this.items.get(id);
    if (!item) return undefined;
    if (item.expiresAt <= this.now()) {
      this.items.delete(id);
      return undefined;
    }
    return item;
  }

  delete(id: string): void {
    this.items.delete(id);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, item] of this.items) if (item.expiresAt <= now) this.items.delete(id);
  }
}

/** A profile the owner can pick on the consent screen. */
export interface ProfileOption {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly scope: string;
  /** Active connections (grants and PATs) on this profile, for the scope-change warning. */
  readonly connections?: number;
}

/** The owner's choice on the consent screen: an existing profile, or a new one; and its scope. */
export interface ConsentProfileChoice {
  /** An existing profile id, or `new`. */
  readonly profileId: string;
  readonly newLabel?: string;
  readonly newKind?: string;
  readonly scope: string;
  /**
   * Set by the confirmation page: `<profileId>:<from>:<to>`. A change to an EXISTING profile's scope is applied only
   * when this matches exactly (v1.0.1, F-15), so it always takes an explicit, confirmed choice.
   */
  readonly confirmScopeChange?: string;
}

/** A scope change on an existing profile that the owner has not yet confirmed. */
export interface ScopeChangeToConfirm {
  readonly profileId: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  /** Active connections on the profile (all of them change). */
  readonly connections: number;
  /** The value the confirmation form sends back as `confirm_scope_change`. */
  readonly token: string;
}

export type ConsentApplyResult =
  | { ok: true; profileId: string }
  | { ok: false; error: string }
  | { ok: false; confirm: ScopeChangeToConfirm };

/**
 * The policy layer's side of consent (implemented in src/policy/consent.ts). The owner, signed in, picks the profile
 * a new connection acts under and that profile's scope. Without it, consent behaves as in chunk 4 (no profile).
 */
export interface ConsentProfiles {
  readonly kinds: readonly string[];
  readonly scopes: readonly string[];
  options(): readonly ProfileOption[];
  /** The scope a NEW profile gets unless the owner chooses another (the configured default, `read` out of the box). */
  defaultScope(): string;
  /** The suggested profile for a redirect URI (claude.ai/claude.com → claude, chatgpt.com → chatgpt, loopback → claude-code). */
  suggest(redirectUri: string): { readonly kind: string; readonly label: string };
  /**
   * Applies the owner's choice (creates the profile, or sets an existing profile's scope, audited). A change to an
   * existing profile's scope without a matching `confirmScopeChange` is not applied: the result asks for confirmation.
   */
  apply(choice: ConsentProfileChoice): ConsentApplyResult;
  /** The profile id a PAT created without one gets. */
  defaultPatProfileId(): string;
}

export interface AuthServices {
  readonly config: AuthConfig;
  readonly store: AuthStore;
  readonly keys: KeyRing;
  readonly event: AuthEventLogger;
  readonly now: () => number;
  readonly clients: ClientService;
  readonly tokens: TokenService;
  readonly owner: OwnerAuth;
  /** OPS2: the owner's password hash, authenticator secret and recovery codes (encrypted store, or the env file). */
  readonly credentials: OwnerCredentials;
  /** OPS2: the owner's env variables imported into the encrypted store at this start (names only). */
  readonly importedCredentials: readonly string[];
  readonly pats: PatService;
  readonly bearer: BearerGuard;
  readonly consents: PendingConsents;
  /** Profile choice at consent (policy layer). Undefined: consent issues grants without a profile. */
  readonly profiles: ConsentProfiles | undefined;
  readonly registrationLimiter: SlidingWindowLimiter;
  readonly sessionHash: (sessionToken: string) => string;
  /** Deletes expired rows; called periodically. */
  readonly prune: () => number;
}

export interface CreateAuthServicesOptions {
  readonly config: AuthConfig;
  readonly db: Db;
  readonly log: FastifyBaseLogger;
  /** Clock in Unix seconds. Tests inject a controllable clock. */
  readonly now?: () => number;
  /** Replaces the SSRF-safe HTTPS fetcher used for Client ID Metadata Documents (tests only). */
  readonly fetchJson?: JsonFetcher;
  /** Replaces the SSRF-safe HTTPS fetcher used for private_key_jwt clients' key sets (tests only). */
  readonly fetchJwks?: JsonFetcher;
  readonly loginLimits?: LoginLimits;
  readonly registrationLimit?: { readonly limit: number; readonly windowMs: number };
  /** The policy layer's consent hooks (profiles and scopes). */
  readonly profiles?: ConsentProfiles;
  /**
   * OPS2: the encrypted secret store. With it, the owner's credentials live there (imported from the env file once);
   * without it (tests of the auth surface alone), the env file's values are used, as in v1.
   */
  readonly secrets?: SecretStore;
}

export function createAuthServices(o: CreateAuthServicesOptions): AuthServices {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const { config } = o;
  const store = new AuthStore(o.db);
  const keys = deriveKeys(config.sessionSecret, config.jwtSigningKey);
  const event = createAuthEventLogger(o.log);
  const fetchJson =
    o.fetchJson ??
    createSafeJsonFetcher({
      timeoutMs: config.cimd.timeoutMs,
      maxBytes: config.cimd.maxBytes,
      ...(config.outboundExtraPorts ? { allowedPorts: config.outboundExtraPorts } : {}),
    });
  const cimd = new CimdFetcher(fetchJson, {
    extraRedirectUris: config.extraRedirectUris,
    defaultCacheSeconds: config.cimd.defaultCacheSeconds,
    maxCacheSeconds: config.cimd.maxCacheSeconds,
  });
  const fetchJwks =
    o.fetchJwks ??
    createJwksFetcher({
      timeoutMs: config.cimd.timeoutMs,
      ...(config.outboundExtraPorts ? { allowedPorts: config.outboundExtraPorts } : {}),
    });
  const assertions = new ClientAssertionVerifier({
    config,
    store,
    jwks: new JwksCache({ fetchJson: fetchJwks, now, event }),
    now,
  });
  const clients = new ClientService({ store, config, cimd, assertions, event, now });
  const tokens = new TokenService({ store, config, keys, event, now });
  const credentials = new OwnerCredentials({
    db: o.db,
    store: o.secrets,
    env: { passwordHash: config.owner.passwordHash, totpSecret: config.owner.totpSecret },
    now,
  });
  // OPS2: OWNER_PASSWORD_HASH and OWNER_TOTP_SECRET move into the encrypted store on the first start with a master key.
  const imported = credentials.importFromEnv();
  if (imported.length > 0) event('secrets.imported', { variables: imported.join(',') });
  const owner = new OwnerAuth({
    store,
    config,
    keys,
    event,
    now,
    credentials,
    ...(o.loginLimits ? { limits: o.loginLimits } : {}),
  });
  const profiles = o.profiles;
  const pats = new PatService({
    store,
    event,
    now,
    ...(profiles ? { defaultProfileId: () => profiles.defaultPatProfileId() } : {}),
  });
  const bearer = new BearerGuard({ config, tokens, pats });
  const reg = o.registrationLimit ?? { limit: 30, windowMs: 3600_000 };
  return {
    config,
    store,
    keys,
    event,
    now,
    clients,
    tokens,
    owner,
    credentials,
    importedCredentials: imported,
    pats,
    bearer,
    consents: new PendingConsents(config.ttl.consentSeconds, now),
    profiles,
    registrationLimiter: new SlidingWindowLimiter(reg.limit, reg.windowMs, () => now() * 1000),
    sessionHash: hashSecret,
    prune: () => store.prune(now()),
  };
}
