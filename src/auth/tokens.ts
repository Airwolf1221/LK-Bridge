import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { AuthConfig } from '../config/auth.js';
import { CODE_VERIFIER, type KeyRing, hashSecret, pkceS256, randomToken, safeEqual } from './crypto.js';
import { invalidGrant, invalidRequest, invalidScope, invalidTarget, unauthorizedClient } from './errors.js';
import type { AuthEventLogger } from './events.js';
import { SUPPORTED_SCOPES, ScopeSyntaxError, formatScope, parseScope } from './scopes.js';
import type { AuthStore, ClientRecord } from './store.js';
import { canonicaliseResource } from './url.js';

export const CODE_PREFIX = 'lkb_ac_';
export const REFRESH_PREFIX = 'lkb_rt_';
export const ACCESS_TOKEN_TYPE = 'at+jwt';

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly scope: string;
}

export interface VerifiedAccessToken {
  readonly jti: string;
  readonly clientId: string;
  readonly scopes: string[];
  readonly expiresAt: number;
  readonly familyId: string | null;
}

export type AccessTokenCheck =
  | { readonly ok: true; readonly token: VerifiedAccessToken }
  | { readonly ok: false; readonly reason: string };

/**
 * RFC 8707: resolve requested `resource` values to the audience this server issues. Absent means
 * the bridge's only resource. Each value is compared in canonical form (lowercase scheme and
 * host, no default port, no trailing slash, no fragment), so `https://LK.example.com/mcp/` is
 * the same resource as `https://lk.example.com/mcp`. The bare origin is accepted as an alias.
 */
export function resolveResource(values: readonly string[], config: AuthConfig): string {
  const audience = canonicaliseResource(config.mcpUrl) as string;
  const origin = canonicaliseResource(config.publicUrl) as string;
  for (const v of values) {
    const c = canonicaliseResource(v);
    if (c !== audience && c !== origin) {
      throw invalidTarget(`This server issues tokens only for ${config.mcpUrl}`);
    }
  }
  return audience;
}

/** A rotation that may be replayed within the grace window (held in memory only, briefly). */
interface RecentRotation {
  readonly until: number;
  readonly clientId: string;
  readonly familyId: string;
  readonly successorHash: string;
  readonly response: Promise<TokenResponse>;
}

export class TokenService {
  private readonly audience: string;
  /** Keyed by the hash of the rotated-out refresh token. Entries live for the grace window. */
  private readonly recentRotations = new Map<string, RecentRotation>();

  constructor(
    private readonly deps: {
      readonly store: AuthStore;
      readonly config: AuthConfig;
      readonly keys: KeyRing;
      readonly event: AuthEventLogger;
      readonly now: () => number;
    },
  ) {
    this.audience = canonicaliseResource(deps.config.mcpUrl) as string;
  }

  /** Creates a single-use authorization code bound to client, redirect URI, PKCE challenge and resource. */
  issueCode(p: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly redirectUriProvided: boolean;
    readonly codeChallenge: string;
    readonly scopes: readonly string[];
    readonly resource: string;
    /** The policy profile the owner chose at consent; the grant (and every token from it) inherits it. */
    readonly profileId?: string | null;
  }): string {
    const code = `${CODE_PREFIX}${randomToken(32)}`;
    const now = this.deps.now();
    this.deps.store.insertCode({
      codeHash: hashSecret(code),
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      redirectUriProvided: p.redirectUriProvided,
      codeChallenge: p.codeChallenge,
      scope: formatScope(p.scopes),
      resource: p.resource,
      createdAt: now,
      expiresAt: now + this.deps.config.ttl.authCodeSeconds,
      profileId: p.profileId ?? null,
    });
    return code;
  }

  /** `grant_type=authorization_code` (RFC 6749 §4.1.3, RFC 7636 §4.6, RFC 8707 §2.2). */
  async exchangeCode(
    client: ClientRecord,
    p: {
      readonly code: string | undefined;
      readonly redirectUri: string | undefined;
      readonly codeVerifier: string | undefined;
      readonly resources: readonly string[];
    },
  ): Promise<TokenResponse> {
    if (!p.code) throw invalidRequest('code is required');
    if (!p.codeVerifier) throw invalidRequest('code_verifier is required (PKCE)');
    const { store } = this.deps;
    const now = this.deps.now();
    const codeHash = hashSecret(p.code);
    const rec = store.getCode(codeHash);
    if (!rec) throw invalidGrant('Authorization code is invalid');
    if (rec.usedAt !== null || !store.consumeCode(codeHash, now)) {
      // RFC 6749 §4.1.2: a reused code revokes the tokens issued from it.
      const again = store.getCode(codeHash);
      if (again?.familyId) store.revokeFamily(again.familyId, 'authorization_code_reuse', now);
      this.deps.event(
        'token.reuse_detected',
        { kind: 'authorization_code', client_id: rec.clientId, grant_id: again?.familyId ?? null },
        'warn',
      );
      throw invalidGrant('Authorization code has already been used');
    }
    // From here the code is spent, whatever the outcome.
    if (rec.expiresAt <= now) throw invalidGrant('Authorization code has expired');
    if (rec.clientId !== client.clientId)
      throw invalidGrant('Authorization code was issued to another client');
    if (
      rec.redirectUriProvided
        ? p.redirectUri !== rec.redirectUri
        : p.redirectUri !== undefined && p.redirectUri !== rec.redirectUri
    ) {
      throw invalidGrant('redirect_uri does not match the authorization request');
    }
    if (!CODE_VERIFIER.test(p.codeVerifier) || !safeEqual(pkceS256(p.codeVerifier), rec.codeChallenge)) {
      throw invalidGrant('PKCE verification failed');
    }
    if (p.resources.length > 0 && resolveResource(p.resources, this.deps.config) !== rec.resource) {
      throw invalidTarget('resource does not match the authorization request');
    }

    const familyId = `grant_${randomUUID()}`;
    const scopes = parseScope(rec.scope);
    const withRefresh = client.grantTypes.includes('refresh_token');
    const { config } = this.deps;
    const access = this.prepareAccess(client.clientId, familyId, scopes, now);
    const refresh = withRefresh ? `${REFRESH_PREFIX}${randomToken(32)}` : undefined;
    store.tx(() => {
      store.insertFamily({
        familyId,
        clientId: client.clientId,
        scope: rec.scope,
        resource: rec.resource,
        createdAt: now,
        expiresAt: now + config.ttl.refreshFamilyMaxSeconds,
        profileId: rec.profileId,
      });
      store.linkCodeToFamily(codeHash, familyId);
      store.insertAccess(access.record);
      if (refresh) {
        store.insertRefresh({
          tokenHash: hashSecret(refresh),
          familyId,
          clientId: client.clientId,
          scope: rec.scope,
          createdAt: now,
          expiresAt: now + config.ttl.refreshTokenSeconds,
        });
      }
      store.touchClient(client.clientId, now);
    });
    this.deps.event('token.issued', {
      grant_type: 'authorization_code',
      client_id: client.clientId,
      grant_id: familyId,
      token_id: access.record.jti,
      scope: rec.scope,
      refresh: withRefresh,
    });
    return this.response(await this.sign(access), scopes, refresh);
  }

  /** `grant_type=refresh_token` with rotation and reuse detection (OAuth 2.1 §4.3.1). */
  async refresh(
    client: ClientRecord,
    p: {
      readonly refreshToken: string | undefined;
      readonly scope: string | undefined;
      readonly resources: readonly string[];
    },
  ): Promise<TokenResponse> {
    if (!p.refreshToken) throw invalidRequest('refresh_token is required');
    const { store, config } = this.deps;
    const now = this.deps.now();
    const tokenHash = hashSecret(p.refreshToken);
    const rec = store.getRefresh(tokenHash);
    if (!rec) throw invalidGrant('Refresh token is invalid');
    if (rec.clientId !== client.clientId) {
      store.revokeFamily(rec.familyId, 'refresh_token_wrong_client', now);
      this.deps.event(
        'token.reuse_detected',
        { kind: 'refresh_token_wrong_client', client_id: client.clientId, grant_id: rec.familyId },
        'warn',
      );
      throw invalidGrant('Refresh token was issued to another client');
    }
    if (rec.revokedAt !== null) throw invalidGrant('Refresh token has been revoked');
    this.sweepRotations(now);
    if (rec.rotatedAt !== null) {
      // Claude refreshes both proactively and on a 401, so two requests can carry the same token.
      // Within the grace window the second one gets the same successor tokens (ADR 0009).
      const replay = this.replayRotation(tokenHash, client.clientId, now);
      if (replay) return replay;
      store.revokeFamily(rec.familyId, 'refresh_token_reuse', now);
      this.deps.event(
        'token.reuse_detected',
        { kind: 'refresh_token', client_id: client.clientId, grant_id: rec.familyId },
        'warn',
      );
      throw invalidGrant('Refresh token has already been used; the grant has been revoked');
    }
    const family = store.getFamily(rec.familyId);
    if (!family || family.revokedAt !== null) throw invalidGrant('The grant has been revoked');
    if (rec.expiresAt <= now || family.expiresAt <= now) throw invalidGrant('Refresh token has expired');
    if (!client.grantTypes.includes('refresh_token')) {
      throw unauthorizedClient('This client is not registered for the refresh_token grant');
    }
    const original = parseScope(rec.scope);
    let scopes = original;
    if (p.scope !== undefined) {
      let requested: string[];
      try {
        // Scopes this server does not support (for example openid or email) are ignored, as at
        // the authorization endpoint; only a supported scope outside the grant is an error.
        requested = parseScope(p.scope).filter((s) => SUPPORTED_SCOPES.includes(s));
      } catch (err) {
        if (err instanceof ScopeSyntaxError) throw invalidScope(err.message);
        throw err;
      }
      if (requested.some((s) => !original.includes(s))) {
        throw invalidScope('A refresh cannot add scopes beyond the original grant');
      }
      if (requested.length > 0) scopes = requested;
    }
    if (p.resources.length > 0 && resolveResource(p.resources, config) !== family.resource) {
      throw invalidTarget('resource does not match the original grant');
    }

    const access = this.prepareAccess(client.clientId, family.familyId, scopes, now);
    const next = `${REFRESH_PREFIX}${randomToken(32)}`;
    const rotated = store.tx(() => {
      if (!store.rotateRefresh(tokenHash, now)) return false;
      store.insertRefresh({
        tokenHash: hashSecret(next),
        familyId: family.familyId,
        clientId: client.clientId,
        scope: rec.scope, // RFC 6749 §6: the new refresh token keeps the original scope
        createdAt: now,
        expiresAt: Math.min(now + config.ttl.refreshTokenSeconds, family.expiresAt),
      });
      store.insertAccess(access.record);
      store.touchFamily(family.familyId, now);
      store.touchClient(client.clientId, now);
      return true;
    });
    if (!rotated) {
      // Lost a race with a concurrent use of the same token: replay within grace, else reuse.
      const replay = this.replayRotation(tokenHash, client.clientId, now);
      if (replay) return replay;
      store.revokeFamily(rec.familyId, 'refresh_token_reuse', now);
      this.deps.event(
        'token.reuse_detected',
        { kind: 'refresh_token', client_id: client.clientId, grant_id: rec.familyId },
        'warn',
      );
      throw invalidGrant('Refresh token has already been used; the grant has been revoked');
    }
    // Registered synchronously, before any await, so a concurrent request always finds it.
    const response = this.sign(access).then((jwt) => this.response(jwt, scopes, next));
    const grace = config.ttl.refreshGraceSeconds;
    if (grace > 0) {
      this.recentRotations.set(tokenHash, {
        until: now + grace,
        clientId: client.clientId,
        familyId: family.familyId,
        successorHash: hashSecret(next),
        response,
      });
    }
    this.deps.event('token.refreshed', {
      client_id: client.clientId,
      grant_id: family.familyId,
      token_id: access.record.jti,
      scope: formatScope(scopes),
    });
    return response;
  }

  /**
   * The successor response for a refresh token rotated less than the grace window ago, provided
   * the same client presents it and neither the grant nor the successor has been revoked since.
   */
  private replayRotation(
    tokenHash: string,
    clientId: string,
    now: number,
  ): Promise<TokenResponse> | undefined {
    const entry = this.recentRotations.get(tokenHash);
    if (!entry || entry.until < now || entry.clientId !== clientId) return undefined;
    const family = this.deps.store.getFamily(entry.familyId);
    const successor = this.deps.store.getRefresh(entry.successorHash);
    if (!family || family.revokedAt !== null || !successor || successor.revokedAt !== null) return undefined;
    this.deps.event('token.refresh_replayed', { client_id: clientId, grant_id: entry.familyId });
    return entry.response;
  }

  private sweepRotations(now: number): void {
    for (const [hash, entry] of this.recentRotations)
      if (entry.until < now) this.recentRotations.delete(hash);
  }

  /** RFC 7009 revocation. Unknown tokens and other clients' tokens are ignored (still 200). */
  async revoke(client: ClientRecord, token: string): Promise<void> {
    const { store } = this.deps;
    const now = this.deps.now();
    if (token.startsWith(REFRESH_PREFIX)) {
      const rec = store.getRefresh(hashSecret(token));
      if (
        rec &&
        rec.clientId === client.clientId &&
        store.revokeFamily(rec.familyId, 'revoked_by_client', now)
      ) {
        this.deps.event('token.revoked', {
          kind: 'refresh_token',
          client_id: client.clientId,
          grant_id: rec.familyId,
        });
      }
      return;
    }
    const claims = await this.verifySignature(token, false);
    if (!claims) return;
    const rec = store.getAccess(claims.jti);
    if (rec && rec.clientId === client.clientId && store.revokeAccess(rec.jti, now)) {
      this.deps.event('token.revoked', {
        kind: 'access_token',
        client_id: client.clientId,
        token_id: rec.jti,
      });
    }
  }

  /** Validates an access token presented at `/mcp`. */
  async verifyAccessToken(token: string): Promise<AccessTokenCheck> {
    const claims = await this.verifySignature(token, true);
    if (!claims) return { ok: false, reason: 'The access token is invalid or expired' };
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.some((a) => typeof a === 'string' && canonicaliseResource(a) === this.audience)) {
      return { ok: false, reason: 'The access token was issued for another resource' };
    }
    const rec = this.deps.store.getAccess(claims.jti);
    if (!rec || rec.revokedAt !== null) return { ok: false, reason: 'The access token has been revoked' };
    const now = this.deps.now();
    if (rec.lastUsedAt === null || now - rec.lastUsedAt >= 60) {
      this.deps.store.touchAccess(rec.jti, now);
      if (rec.familyId) this.deps.store.touchFamily(rec.familyId, now);
    }
    return {
      ok: true,
      token: {
        jti: rec.jti,
        clientId: rec.clientId,
        scopes: parseScope(claims.scope),
        expiresAt: claims.exp,
        familyId: rec.familyId,
      },
    };
  }

  private prepareAccess(clientId: string, familyId: string, scopes: readonly string[], now: number) {
    const jti = randomUUID();
    const expiresAt = now + this.deps.config.ttl.accessTokenSeconds;
    return {
      record: {
        jti,
        familyId,
        clientId,
        scope: formatScope(scopes),
        audience: this.audience,
        createdAt: now,
        expiresAt,
      },
    };
  }

  private sign(access: ReturnType<TokenService['prepareAccess']>): Promise<string> {
    const { record } = access;
    return new SignJWT({ client_id: record.clientId, scope: record.scope })
      .setProtectedHeader({ alg: 'HS256', typ: ACCESS_TOKEN_TYPE })
      .setIssuer(this.deps.config.issuer)
      .setSubject(this.deps.config.owner.username)
      .setAudience(record.audience)
      .setJti(record.jti)
      .setIssuedAt(record.createdAt)
      .setExpirationTime(record.expiresAt)
      .sign(this.deps.keys.jwt);
  }

  private async verifySignature(
    token: string,
    checkExpiry: boolean,
  ): Promise<{ jti: string; aud: string | string[]; exp: number; scope: string } | undefined> {
    if (token.length > 4096 || token.split('.').length !== 3) return undefined;
    try {
      const nowSeconds = this.deps.now();
      const { payload } = await jwtVerify(token, this.deps.keys.jwt, {
        algorithms: ['HS256'],
        issuer: this.deps.config.issuer,
        typ: ACCESS_TOKEN_TYPE,
        requiredClaims: ['jti', 'exp', 'iat', 'aud'],
        currentDate: new Date((checkExpiry ? nowSeconds : 0) * 1000),
        clockTolerance: 5,
      });
      if (typeof payload.jti !== 'string' || typeof payload.exp !== 'number' || payload.aud === undefined) {
        return undefined;
      }
      return {
        jti: payload.jti,
        aud: payload.aud,
        exp: payload.exp,
        scope: typeof payload.scope === 'string' ? payload.scope : '',
      };
    } catch {
      return undefined;
    }
  }

  private response(
    accessToken: string,
    scopes: readonly string[],
    refreshToken: string | undefined,
  ): TokenResponse {
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.deps.config.ttl.accessTokenSeconds,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      scope: formatScope(scopes),
    };
  }
}
