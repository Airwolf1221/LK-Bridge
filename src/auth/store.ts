import type { Db } from '../db/open.js';

/** Persistence for the auth tables (migrations 0100_auth_init.sql and 0101_client_assertion_jti.sql). Times are Unix seconds. */

export type TokenEndpointAuthMethod =
  'none' | 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt';

export interface ClientRecord {
  readonly clientId: string;
  readonly kind: 'dcr' | 'cimd';
  readonly clientName: string | null;
  readonly redirectUris: string[];
  readonly grantTypes: string[];
  readonly responseTypes: string[];
  readonly tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  readonly clientSecretHash: string | null;
  readonly scope: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadataExpiresAt: number | null;
  readonly lastUsedAt: number | null;
}

export interface CodeRecord {
  readonly codeHash: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly redirectUriProvided: boolean;
  readonly codeChallenge: string;
  readonly scope: string;
  readonly resource: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly usedAt: number | null;
  readonly familyId: string | null;
  /** The policy profile the owner chose at consent (migration 0300); the grant inherits it. */
  readonly profileId: string | null;
  /** Hotfix (migration 1400, ADR 0033): grants the owner ticked on the consent page, revoked once this code is exchanged. */
  readonly replaces: string[];
}

export interface FamilyRecord {
  readonly familyId: string;
  readonly clientId: string;
  readonly scope: string;
  readonly resource: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly revokedReason: string | null;
  readonly lastUsedAt: number | null;
  /** The policy profile (migration 0300). Null only for a grant made without the policy layer. */
  readonly profileId: string | null;
}

export interface RefreshRecord {
  readonly tokenHash: string;
  readonly familyId: string;
  readonly clientId: string;
  readonly scope: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly rotatedAt: number | null;
  readonly revokedAt: number | null;
}

export interface AccessRecord {
  readonly jti: string;
  readonly familyId: string | null;
  readonly clientId: string;
  readonly scope: string;
  readonly audience: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly lastUsedAt: number | null;
}

export interface PatRecord {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly tokenHint: string;
  readonly scope: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly lastUsedAt: number | null;
  /** The policy profile (migration 0300). */
  readonly profileId: string | null;
}

export interface SessionRecord {
  readonly sessionHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastSeenAt: number;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly revokedAt: number | null;
  /** OPS2: when this session last re-confirmed the owner's password (and second factor); null: never. */
  readonly reauthAt: number | null;
}

type Row = Record<string, unknown>;

const json = (v: unknown) => JSON.stringify(v);
const parseArr = (v: unknown): string[] => JSON.parse(String(v)) as string[];
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? v.toString() : null;

function toClient(r: Row): ClientRecord {
  return {
    clientId: String(r.client_id),
    kind: r.kind as 'dcr' | 'cimd',
    clientName: str(r.client_name),
    redirectUris: parseArr(r.redirect_uris),
    grantTypes: parseArr(r.grant_types),
    responseTypes: parseArr(r.response_types),
    tokenEndpointAuthMethod: r.token_endpoint_auth_method as TokenEndpointAuthMethod,
    clientSecretHash: str(r.client_secret_hash),
    scope: str(r.scope),
    metadata: JSON.parse(String(r.metadata)) as Record<string, unknown>,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    metadataExpiresAt: num(r.metadata_expires_at),
    lastUsedAt: num(r.last_used_at),
  };
}

function toCode(r: Row): CodeRecord {
  return {
    codeHash: String(r.code_hash),
    clientId: String(r.client_id),
    redirectUri: String(r.redirect_uri),
    redirectUriProvided: Number(r.redirect_uri_provided) === 1,
    codeChallenge: String(r.code_challenge),
    scope: String(r.scope),
    resource: String(r.resource),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    usedAt: num(r.used_at),
    familyId: str(r.family_id),
    profileId: str(r.profile_id),
    replaces: parseReplaces(r.replaces),
  };
}

function parseReplaces(v: unknown): string[] {
  if (typeof v !== 'string' || v === '') return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toFamily(r: Row): FamilyRecord {
  return {
    familyId: String(r.family_id),
    clientId: String(r.client_id),
    scope: String(r.scope),
    resource: String(r.resource),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    revokedAt: num(r.revoked_at),
    revokedReason: str(r.revoked_reason),
    lastUsedAt: num(r.last_used_at),
    profileId: str(r.profile_id),
  };
}

function toRefresh(r: Row): RefreshRecord {
  return {
    tokenHash: String(r.token_hash),
    familyId: String(r.family_id),
    clientId: String(r.client_id),
    scope: String(r.scope),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    rotatedAt: num(r.rotated_at),
    revokedAt: num(r.revoked_at),
  };
}

function toAccess(r: Row): AccessRecord {
  return {
    jti: String(r.jti),
    familyId: str(r.family_id),
    clientId: String(r.client_id),
    scope: String(r.scope),
    audience: String(r.audience),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    revokedAt: num(r.revoked_at),
    lastUsedAt: num(r.last_used_at),
  };
}

function toPat(r: Row): PatRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    tokenHash: String(r.token_hash),
    tokenHint: String(r.token_hint),
    scope: String(r.scope),
    createdAt: Number(r.created_at),
    expiresAt: num(r.expires_at),
    revokedAt: num(r.revoked_at),
    lastUsedAt: num(r.last_used_at),
    profileId: str(r.profile_id),
  };
}

function toSession(r: Row): SessionRecord {
  return {
    sessionHash: String(r.session_hash),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    lastSeenAt: Number(r.last_seen_at),
    ip: str(r.ip),
    userAgent: str(r.user_agent),
    revokedAt: num(r.revoked_at),
    reauthAt: num(r.reauth_at),
  };
}

export class AuthStore {
  constructor(readonly db: Db) {}

  /** Runs `fn` in one SQLite transaction (synchronous, so atomic within this process). */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- Clients ---

  getClient(clientId: string): ClientRecord | undefined {
    const r = this.db.prepare('SELECT * FROM auth_clients WHERE client_id = ?').get(clientId) as
      Row | undefined;
    return r ? toClient(r) : undefined;
  }

  listClients(): ClientRecord[] {
    return (this.db.prepare('SELECT * FROM auth_clients ORDER BY created_at DESC').all() as Row[]).map(
      toClient,
    );
  }

  /** Inserts or replaces a client registration (DCR insert, CIMD refresh). */
  saveClient(c: ClientRecord): void {
    this.db
      .prepare(
        `INSERT INTO auth_clients (client_id, kind, client_name, redirect_uris, grant_types, response_types,
           token_endpoint_auth_method, client_secret_hash, scope, metadata, created_at, updated_at,
           metadata_expires_at, last_used_at)
         VALUES (@clientId, @kind, @clientName, @redirectUris, @grantTypes, @responseTypes,
           @tokenEndpointAuthMethod, @clientSecretHash, @scope, @metadata, @createdAt, @updatedAt,
           @metadataExpiresAt, @lastUsedAt)
         ON CONFLICT (client_id) DO UPDATE SET
           kind = excluded.kind, client_name = excluded.client_name, redirect_uris = excluded.redirect_uris,
           grant_types = excluded.grant_types, response_types = excluded.response_types,
           token_endpoint_auth_method = excluded.token_endpoint_auth_method,
           client_secret_hash = excluded.client_secret_hash, scope = excluded.scope,
           metadata = excluded.metadata, updated_at = excluded.updated_at,
           metadata_expires_at = excluded.metadata_expires_at`,
      )
      .run({
        ...c,
        redirectUris: json(c.redirectUris),
        grantTypes: json(c.grantTypes),
        responseTypes: json(c.responseTypes),
        metadata: json(c.metadata),
      });
  }

  touchClient(clientId: string, now: number): void {
    this.db.prepare('UPDATE auth_clients SET last_used_at = ? WHERE client_id = ?').run(now, clientId);
  }

  /** Deletes a client and, by cascade, its codes, grants and tokens. */
  deleteClient(clientId: string): boolean {
    return this.db.prepare('DELETE FROM auth_clients WHERE client_id = ?').run(clientId).changes === 1;
  }

  countClients(kind: 'dcr' | 'cimd'): number {
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM auth_clients WHERE kind = ?').get(kind) as Row).n,
    );
  }

  // --- Authorization codes ---

  insertCode(
    c: Omit<CodeRecord, 'usedAt' | 'familyId' | 'profileId' | 'replaces'> & {
      profileId?: string | null;
      replaces?: readonly string[];
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO auth_codes (code_hash, client_id, redirect_uri, redirect_uri_provided, code_challenge, scope,
           resource, created_at, expires_at, profile_id, replaces) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.codeHash,
        c.clientId,
        c.redirectUri,
        c.redirectUriProvided ? 1 : 0,
        c.codeChallenge,
        c.scope,
        c.resource,
        c.createdAt,
        c.expiresAt,
        c.profileId ?? null,
        c.replaces && c.replaces.length > 0 ? json(c.replaces) : null,
      );
  }

  getCode(codeHash: string): CodeRecord | undefined {
    const r = this.db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(codeHash) as
      Row | undefined;
    return r ? toCode(r) : undefined;
  }

  /** Marks a code used. Returns false if it was already used (a concurrent or replayed exchange). */
  consumeCode(codeHash: string, now: number): boolean {
    return (
      this.db
        .prepare('UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
        .run(now, codeHash).changes === 1
    );
  }

  linkCodeToFamily(codeHash: string, familyId: string): void {
    this.db.prepare('UPDATE auth_codes SET family_id = ? WHERE code_hash = ?').run(familyId, codeHash);
  }

  // --- Grants (token families) ---

  insertFamily(
    f: Omit<FamilyRecord, 'revokedAt' | 'revokedReason' | 'lastUsedAt' | 'profileId'> & {
      profileId?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO auth_token_families (family_id, client_id, scope, resource, created_at, expires_at, profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(f.familyId, f.clientId, f.scope, f.resource, f.createdAt, f.expiresAt, f.profileId ?? null);
  }

  getFamily(familyId: string): FamilyRecord | undefined {
    const r = this.db.prepare('SELECT * FROM auth_token_families WHERE family_id = ?').get(familyId) as
      Row | undefined;
    return r ? toFamily(r) : undefined;
  }

  listFamilies(): FamilyRecord[] {
    return (this.db.prepare('SELECT * FROM auth_token_families ORDER BY created_at DESC').all() as Row[]).map(
      toFamily,
    );
  }

  /** Revokes a grant and every token in it. Returns false if it was already revoked. */
  revokeFamily(familyId: string, reason: string, now: number): boolean {
    return this.tx(() => {
      const changed =
        this.db
          .prepare(
            'UPDATE auth_token_families SET revoked_at = ?, revoked_reason = ? WHERE family_id = ? AND revoked_at IS NULL',
          )
          .run(now, reason, familyId).changes === 1;
      this.db
        .prepare('UPDATE auth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
        .run(now, familyId);
      this.db
        .prepare('UPDATE auth_access_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
        .run(now, familyId);
      return changed;
    });
  }

  /**
   * Deletes a grant's credentials: its token family and every refresh token, access token and authorisation code of
   * it (hotfix, ADR 0033). The refresh and access tokens would cascade; they are deleted by name anyway, and the codes
   * (whose `family_id` is a plain column, no foreign key) only by name. `auth_clients` is never touched: a client
   * registration may serve other grants. Run it inside the caller's transaction.
   */
  deleteGrantCredentials(familyId: string): {
    family: number;
    refresh: number;
    access: number;
    codes: number;
  } {
    return this.tx(() => {
      const codes = this.db.prepare('DELETE FROM auth_codes WHERE family_id = ?').run(familyId).changes;
      const refresh = this.db
        .prepare('DELETE FROM auth_refresh_tokens WHERE family_id = ?')
        .run(familyId).changes;
      const access = this.db
        .prepare('DELETE FROM auth_access_tokens WHERE family_id = ?')
        .run(familyId).changes;
      const family = this.db
        .prepare('DELETE FROM auth_token_families WHERE family_id = ?')
        .run(familyId).changes;
      return { family, refresh, access, codes };
    });
  }

  touchFamily(familyId: string, now: number): void {
    this.db.prepare('UPDATE auth_token_families SET last_used_at = ? WHERE family_id = ?').run(now, familyId);
  }

  // --- Refresh tokens ---

  insertRefresh(r: Omit<RefreshRecord, 'rotatedAt' | 'revokedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO auth_refresh_tokens (token_hash, family_id, client_id, scope, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.tokenHash, r.familyId, r.clientId, r.scope, r.createdAt, r.expiresAt);
  }

  getRefresh(tokenHash: string): RefreshRecord | undefined {
    const r = this.db.prepare('SELECT * FROM auth_refresh_tokens WHERE token_hash = ?').get(tokenHash) as
      Row | undefined;
    return r ? toRefresh(r) : undefined;
  }

  /** Marks a refresh token rotated. Returns false if it was already rotated or revoked. */
  rotateRefresh(tokenHash: string, now: number): boolean {
    return (
      this.db
        .prepare(
          'UPDATE auth_refresh_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL AND revoked_at IS NULL',
        )
        .run(now, tokenHash).changes === 1
    );
  }

  // --- Access tokens ---

  insertAccess(a: Omit<AccessRecord, 'revokedAt' | 'lastUsedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO auth_access_tokens (jti, family_id, client_id, scope, audience, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.jti, a.familyId, a.clientId, a.scope, a.audience, a.createdAt, a.expiresAt);
  }

  getAccess(jti: string): AccessRecord | undefined {
    const r = this.db.prepare('SELECT * FROM auth_access_tokens WHERE jti = ?').get(jti) as Row | undefined;
    return r ? toAccess(r) : undefined;
  }

  revokeAccess(jti: string, now: number): boolean {
    return (
      this.db
        .prepare('UPDATE auth_access_tokens SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL')
        .run(now, jti).changes === 1
    );
  }

  touchAccess(jti: string, now: number): void {
    this.db.prepare('UPDATE auth_access_tokens SET last_used_at = ? WHERE jti = ?').run(now, jti);
  }

  listAccessTokens(): AccessRecord[] {
    return (this.db.prepare('SELECT * FROM auth_access_tokens ORDER BY created_at DESC').all() as Row[]).map(
      toAccess,
    );
  }

  // --- Personal access tokens ---

  insertPat(
    p: Omit<PatRecord, 'revokedAt' | 'lastUsedAt' | 'profileId'> & { profileId?: string | null },
  ): void {
    this.db
      .prepare(
        `INSERT INTO auth_pats (id, name, token_hash, token_hint, scope, created_at, expires_at, profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.name, p.tokenHash, p.tokenHint, p.scope, p.createdAt, p.expiresAt, p.profileId ?? null);
  }

  getPatByHash(tokenHash: string): PatRecord | undefined {
    const r = this.db.prepare('SELECT * FROM auth_pats WHERE token_hash = ?').get(tokenHash) as
      Row | undefined;
    return r ? toPat(r) : undefined;
  }

  listPats(): PatRecord[] {
    return (this.db.prepare('SELECT * FROM auth_pats ORDER BY created_at DESC').all() as Row[]).map(toPat);
  }

  revokePat(id: string, now: number): boolean {
    return (
      this.db.prepare('UPDATE auth_pats SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id)
        .changes === 1
    );
  }

  /** Deletes a personal access token (hotfix, ADR 0033). Run it inside the caller's transaction. */
  deletePat(id: string): boolean {
    return this.db.prepare('DELETE FROM auth_pats WHERE id = ?').run(id).changes === 1;
  }

  touchPat(id: string, now: number): void {
    this.db.prepare('UPDATE auth_pats SET last_used_at = ? WHERE id = ?').run(now, id);
  }

  // --- Owner sessions ---

  insertSession(s: Omit<SessionRecord, 'revokedAt' | 'reauthAt'>): void {
    this.db
      .prepare(
        `INSERT INTO auth_owner_sessions (session_hash, created_at, expires_at, last_seen_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(s.sessionHash, s.createdAt, s.expiresAt, s.lastSeenAt, s.ip, s.userAgent);
  }

  getSession(sessionHash: string): SessionRecord | undefined {
    const r = this.db.prepare('SELECT * FROM auth_owner_sessions WHERE session_hash = ?').get(sessionHash) as
      Row | undefined;
    return r ? toSession(r) : undefined;
  }

  touchSession(sessionHash: string, now: number): void {
    this.db
      .prepare('UPDATE auth_owner_sessions SET last_seen_at = ? WHERE session_hash = ?')
      .run(now, sessionHash);
  }

  revokeSession(sessionHash: string, now: number): void {
    this.db
      .prepare('UPDATE auth_owner_sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL')
      .run(now, sessionHash);
  }

  /** OPS2: records a successful re-authentication on a session. */
  setReauth(sessionHash: string, now: number): void {
    this.db
      .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ? AND revoked_at IS NULL')
      .run(now, sessionHash);
  }

  /** OPS2: signs out every owner session except `keepHash` (after a password change). Returns how many. */
  revokeOtherSessions(keepHash: string, now: number): number {
    return this.db
      .prepare('UPDATE auth_owner_sessions SET revoked_at = ? WHERE session_hash <> ? AND revoked_at IS NULL')
      .run(now, keepHash).changes;
  }

  // --- Owner state ---

  /**
   * Records a TOTP time step as used. Returns false if this step (or a later one) was already
   * used, which blocks replay of a code within its validity window.
   */
  claimTotpStep(step: number, now: number): boolean {
    return this.tx(() => {
      const row = this.db.prepare('SELECT totp_last_step FROM auth_owner_state WHERE id = 1').get() as
        Row | undefined;
      const last = row ? num(row.totp_last_step) : null;
      if (last !== null && step <= last) return false;
      this.db
        .prepare(
          `INSERT INTO auth_owner_state (id, totp_last_step, updated_at) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET totp_last_step = excluded.totp_last_step, updated_at = excluded.updated_at`,
        )
        .run(step, now);
      return true;
    });
  }

  // --- Client assertion jtis (migration 0101) ---

  /**
   * Records a `private_key_jwt` assertion's `jti` for `clientId` until `expiresAt`. Returns false when the same jti is
   * already recorded and not yet expired (a replay). An expired record of the same jti is replaced.
   */
  claimAssertionJti(clientId: string, jti: string, expiresAt: number, now: number): boolean {
    return this.tx(() => {
      this.db
        .prepare('DELETE FROM auth_client_assertion_jtis WHERE client_id = ? AND jti = ? AND expires_at < ?')
        .run(clientId, jti, now);
      return (
        this.db
          .prepare(
            `INSERT INTO auth_client_assertion_jtis (client_id, jti, expires_at, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (client_id, jti) DO NOTHING`,
          )
          .run(clientId, jti, expiresAt, now).changes === 1
      );
    });
  }

  // --- Housekeeping ---

  /**
   * Deletes expired and long-dead codes, tokens and sessions. Returns the rows removed.
   * Client registrations are never removed here: DCR clients (ChatGPT reuses one per connection)
   * and CIMD records live until deleted explicitly with {@link deleteClient} (ADR 0008).
   * Grants (token families) and personal access tokens are not removed here either (ADR 0033): history names a
   * connection by its id, so a removal leaves a tombstone, and only the owner (Clients & Access) or the daily
   * `connection-removal` sweep removes one, through the policy layer.
   */
  prune(now: number): number {
    const day = 86400;
    return this.tx(() => {
      let n = 0;
      n += this.db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(now - day).changes;
      n += this.db.prepare('DELETE FROM auth_access_tokens WHERE expires_at < ?').run(now - day).changes;
      n += this.db
        .prepare(
          'DELETE FROM auth_refresh_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
        )
        .run(now - day, now - 30 * day).changes;
      n += this.db
        .prepare(
          'DELETE FROM auth_owner_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
        )
        .run(now, now - day).changes;
      n += this.db.prepare('DELETE FROM auth_client_assertion_jtis WHERE expires_at < ?').run(now).changes;
      return n;
    });
  }
}
