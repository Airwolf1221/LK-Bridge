import type { FastifyBaseLogger } from 'fastify';
import type { AuthConfig } from '../config/auth.js';
import type { Db } from '../db/open.js';
import { BearerGuard } from './bearer.js';
import { CimdFetcher } from './cimd.js';
import { ClientService } from './clients.js';
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

export interface AuthServices {
  readonly config: AuthConfig;
  readonly store: AuthStore;
  readonly keys: KeyRing;
  readonly event: AuthEventLogger;
  readonly now: () => number;
  readonly clients: ClientService;
  readonly tokens: TokenService;
  readonly owner: OwnerAuth;
  readonly pats: PatService;
  readonly bearer: BearerGuard;
  readonly consents: PendingConsents;
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
  readonly loginLimits?: LoginLimits;
  readonly registrationLimit?: { readonly limit: number; readonly windowMs: number };
}

export function createAuthServices(o: CreateAuthServicesOptions): AuthServices {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const { config } = o;
  const store = new AuthStore(o.db);
  const keys = deriveKeys(config.sessionSecret, config.jwtSigningKey);
  const event = createAuthEventLogger(o.log);
  const fetchJson =
    o.fetchJson ??
    createSafeJsonFetcher({ timeoutMs: config.cimd.timeoutMs, maxBytes: config.cimd.maxBytes });
  const cimd = new CimdFetcher(fetchJson, {
    extraRedirectUris: config.extraRedirectUris,
    defaultCacheSeconds: config.cimd.defaultCacheSeconds,
    maxCacheSeconds: config.cimd.maxCacheSeconds,
  });
  const clients = new ClientService({ store, config, cimd, event, now });
  const tokens = new TokenService({ store, config, keys, event, now });
  const owner = new OwnerAuth({
    store,
    config,
    keys,
    event,
    now,
    ...(o.loginLimits ? { limits: o.loginLimits } : {}),
  });
  const pats = new PatService({ store, event, now });
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
    pats,
    bearer,
    consents: new PendingConsents(config.ttl.consentSeconds, now),
    registrationLimiter: new SlidingWindowLimiter(reg.limit, reg.windowMs, () => now() * 1000),
    sessionHash: hashSecret,
    prune: () => store.prune(now(), { unusedDcrClientSeconds: 86400 }),
  };
}
