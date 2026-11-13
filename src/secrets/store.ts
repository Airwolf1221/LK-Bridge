/**
 * The encrypted secret store (OPS2, ADR 0028; migration 1000): LegendKeeper API keys (one per project), the owner's
 * password hash and authenticator secret. Synchronous, like every other store.
 *
 * - Every value is sealed with AES-256-GCM (crypto.ts) under a key derived from SECRETS_MASTER_KEY, with the row's
 *   scope (a project id, or '*' for the owner) and purpose as associated data.
 * - A missing or wrong master key affects only the secrets it cannot open: `read` says why (`no_master_key`,
 *   `wrong_master_key`, `damaged`), and `state()` lists every unreadable row for the dashboard. Nothing throws at start.
 * - SECRETS_MASTER_KEY_PREVIOUS (set by `env-sync.sh --rotate-master-key`) can still open rows sealed with the previous
 *   key; `rotate()` re-seals them with the current one (`npm run secrets -- rotate-master-key`). New values are always
 *   sealed with the current key.
 * - Values never leave this class except as `read()`'s result: no method logs, and errors carry no value.
 */
import { safeEqual } from '../auth/crypto.js';
import type { Db } from '../db/open.js';
import {
  type MasterKey,
  MIN_MASTER_KEY_LENGTH,
  deriveMasterKey,
  envValueDigest,
  open,
  seal,
} from './crypto.js';

export type SecretPurpose =
  | 'lk_api_key'
  | 'owner_password_hash'
  | 'owner_totp_secret'
  // v2 E1b (ADR 0043, migration 2200): the off-site copy's Google client, refresh token and rclone crypt keys.
  | 'drive_client_id'
  | 'drive_client_secret'
  | 'drive_refresh_token'
  | 'drive_crypt_password'
  | 'drive_crypt_salt';
/** The scope of the owner's own secrets (an API key's scope is its project's LegendKeeper id). */
export const OWNER_SCOPE = '*';
/** v2 E1b: the scope of the off-site copy's secrets. */
export const OFFSITE_SCOPE = 'offsite';

export type SecretSource = 'env_import' | 'dashboard';

export type UnreadableReason = 'no_master_key' | 'wrong_master_key' | 'damaged';

export type ReadResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'not_stored' }
  | { readonly ok: false; readonly reason: UnreadableReason; readonly message: string };

/** What may be shown about a stored secret: never the value. */
export interface SecretMeta {
  readonly scope: string;
  readonly purpose: SecretPurpose;
  readonly hint: string | null;
  readonly source: SecretSource;
  /** Which master key sealed it: the current one, the previous one (rotation pending), or neither. */
  readonly sealedWith: 'current' | 'previous' | 'unknown';
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SecretStoreState {
  /** SECRETS_MASTER_KEY is set and valid, so secrets can be written. */
  readonly available: boolean;
  /** Plain-language reason it is not, or why some stored secrets cannot be read. Never a value. */
  readonly problem: string | null;
  readonly keyId: string | null;
  readonly stored: number;
  readonly unreadable: readonly { scope: string; purpose: SecretPurpose; reason: UnreadableReason }[];
  /** Rows still sealed with SECRETS_MASTER_KEY_PREVIOUS (run the rotation command). */
  readonly underPrevious: number;
}

export class SecretStoreError extends Error {
  override readonly name = 'SecretStoreError';
  constructor(
    readonly code: 'UNAVAILABLE' | 'ROTATION_REFUSED',
    message: string,
  ) {
    super(message);
  }
}

interface Row {
  scope: string;
  purpose: SecretPurpose;
  key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
  hint: string | null;
  source: SecretSource;
  created_at: number;
  updated_at: number;
}

export interface SecretKeys {
  /** SECRETS_MASTER_KEY. */
  readonly masterKey?: string | undefined;
  /** SECRETS_MASTER_KEY_PREVIOUS: only opens rows sealed before a rotation. */
  readonly previousMasterKey?: string | undefined;
}

export const MASTER_KEY_MISSING =
  'SECRETS_MASTER_KEY is not set in the env file, so the encrypted secret store cannot be used. Add it with ' +
  '`sudo /opt/lk-bridge/bin/env-sync.sh` (it generates one), then restart the bridge.';

export class SecretStore {
  private readonly current: MasterKey | null;
  private readonly previous: MasterKey | null;
  /** Why the master key itself is unusable (too short), or null. */
  private readonly keyProblem: string | null;

  constructor(
    readonly db: Db,
    keys: SecretKeys,
    private readonly now: () => number = Date.now,
  ) {
    const raw = keys.masterKey?.trim() ?? '';
    const prev = keys.previousMasterKey?.trim() ?? '';
    this.keyProblem =
      raw === ''
        ? MASTER_KEY_MISSING
        : raw.length < MIN_MASTER_KEY_LENGTH
          ? `SECRETS_MASTER_KEY is shorter than ${MIN_MASTER_KEY_LENGTH} characters, so it is not used.`
          : null;
    this.current = this.keyProblem === null ? deriveMasterKey(raw) : null;
    this.previous = prev.length >= MIN_MASTER_KEY_LENGTH ? deriveMasterKey(prev) : null;
  }

  /** Secrets can be written (and those sealed with the current key read). */
  get available(): boolean {
    return this.current !== null;
  }

  get keyId(): string | null {
    return this.current?.id ?? null;
  }

  // ============================================================================================ reading

  has(scope: string, purpose: SecretPurpose): boolean {
    return this.row(scope, purpose) !== undefined;
  }

  read(scope: string, purpose: SecretPurpose): ReadResult {
    const r = this.row(scope, purpose);
    if (!r) return { ok: false, reason: 'not_stored' };
    return this.openRow(r);
  }

  meta(scope: string, purpose: SecretPurpose): SecretMeta | undefined {
    const r = this.row(scope, purpose);
    return r ? this.toMeta(r) : undefined;
  }

  list(): SecretMeta[] {
    return this.rows().map((r) => this.toMeta(r));
  }

  /** Constant-time comparison of a candidate with the stored value. False when nothing readable is stored. */
  equals(scope: string, purpose: SecretPurpose, candidate: string): boolean {
    const r = this.read(scope, purpose);
    return r.ok && safeEqual(r.value, candidate);
  }

  state(): SecretStoreState {
    const rows = this.rows();
    const unreadable: { scope: string; purpose: SecretPurpose; reason: UnreadableReason }[] = [];
    let underPrevious = 0;
    for (const r of rows) {
      const opened = this.openRow(r);
      if (!opened.ok) unreadable.push({ scope: r.scope, purpose: r.purpose, reason: opened.reason });
      else if (this.previous && r.key_id === this.previous.id && r.key_id !== this.current?.id)
        underPrevious += 1;
    }
    let problem = this.keyProblem;
    if (problem === null && unreadable.length > 0) {
      const wrong = unreadable.some((u) => u.reason === 'wrong_master_key');
      problem = wrong
        ? `${unreadable.length} stored secret(s) were sealed with another master key than SECRETS_MASTER_KEY, so they cannot be read. Put the right SECRETS_MASTER_KEY back (or set the old one as SECRETS_MASTER_KEY_PREVIOUS) and restart.`
        : `${unreadable.length} stored secret(s) are damaged and cannot be read. Restore the database from a backup, or set those secrets again.`;
    } else if (problem !== null && rows.length > 0) {
      problem = `${problem} ${rows.length} stored secret(s) cannot be read until then.`;
    }
    return {
      available: this.current !== null,
      problem,
      keyId: this.current?.id ?? null,
      stored: rows.length,
      unreadable,
      underPrevious,
    };
  }

  // ============================================================================================ writing

  /**
   * Stores (or atomically replaces) one secret, sealed with the current master key. Throws `SecretStoreError`
   * (`UNAVAILABLE`) without a usable master key; nothing is written then.
   */
  write(
    scope: string,
    purpose: SecretPurpose,
    value: string,
    o: { readonly source: SecretSource; readonly hint?: string | null },
  ): void {
    const mk = this.requireKey();
    const s = seal(mk, scope, purpose, value);
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO secrets (scope, purpose, key_id, nonce, ciphertext, tag, hint, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, purpose) DO UPDATE SET key_id = excluded.key_id, nonce = excluded.nonce,
           ciphertext = excluded.ciphertext, tag = excluded.tag, hint = excluded.hint, source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run(scope, purpose, s.keyId, s.nonce, s.ciphertext, s.tag, o.hint ?? null, o.source, at, at);
  }

  remove(scope: string, purpose: SecretPurpose): boolean {
    return (
      this.db.prepare('DELETE FROM secrets WHERE scope = ? AND purpose = ?').run(scope, purpose).changes > 0
    );
  }

  // ============================================================================================ env imports

  /** The digest of the env value imported for `variable`, or undefined if it was never imported. */
  imported(variable: string): string | undefined {
    const r = this.db.prepare('SELECT sha256 FROM secret_imports WHERE variable = ?').get(variable) as
      { sha256: string } | undefined;
    return r?.sha256;
  }

  /** Records that `variable` was imported (once; a later call keeps the first record). */
  recordImport(variable: string, scope: string, purpose: SecretPurpose, value: string): void {
    this.db
      .prepare(
        `INSERT INTO secret_imports (variable, scope, purpose, sha256, imported_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (variable) DO NOTHING`,
      )
      .run(variable, scope, purpose, envValueDigest(variable, value), this.now());
  }

  /** Whether `value` is exactly what was imported from `variable` (constant time). */
  wasImportedAs(variable: string, value: string): boolean {
    const d = this.imported(variable);
    return d !== undefined && safeEqual(d, envValueDigest(variable, value));
  }

  // ============================================================================================ rotation

  /**
   * Re-seals every row sealed with SECRETS_MASTER_KEY_PREVIOUS with SECRETS_MASTER_KEY, in one transaction. Rows already
   * under the current key are left alone, so running it twice is harmless. Refuses (changing nothing) when a row opens
   * under neither key. Take a backup first (the CLI does).
   */
  rotate(): { readonly resealed: number; readonly alreadyCurrent: number } {
    const mk = this.requireKey();
    if (!this.previous) {
      throw new SecretStoreError(
        'ROTATION_REFUSED',
        'SECRETS_MASTER_KEY_PREVIOUS is not set (or shorter than 32 characters): there is no previous key to rotate from. Run `sudo /opt/lk-bridge/bin/env-sync.sh --rotate-master-key` first.',
      );
    }
    const prev = this.previous;
    return this.db.transaction(() => {
      let resealed = 0;
      let alreadyCurrent = 0;
      const rows = this.rows();
      const plan: { r: Row; value: string }[] = [];
      for (const r of rows) {
        if (r.key_id === mk.id && open(mk, r.scope, r.purpose, r) !== undefined) {
          alreadyCurrent += 1;
          continue;
        }
        const value = r.key_id === prev.id ? open(prev, r.scope, r.purpose, r) : undefined;
        if (value === undefined) {
          throw new SecretStoreError(
            'ROTATION_REFUSED',
            `The ${r.purpose} secret of ${r.scope === OWNER_SCOPE ? 'the owner' : `project ${r.scope}`} opens with neither SECRETS_MASTER_KEY nor SECRETS_MASTER_KEY_PREVIOUS. Nothing was changed.`,
          );
        }
        plan.push({ r, value });
      }
      const update = this.db.prepare(
        'UPDATE secrets SET key_id = ?, nonce = ?, ciphertext = ?, tag = ? WHERE scope = ? AND purpose = ?',
      );
      for (const { r, value } of plan) {
        const s = seal(mk, r.scope, r.purpose, value);
        update.run(s.keyId, s.nonce, s.ciphertext, s.tag, r.scope, r.purpose);
        resealed += 1;
      }
      return { resealed, alreadyCurrent };
    })();
  }

  // ============================================================================================ internals

  private requireKey(): MasterKey {
    if (!this.current) throw new SecretStoreError('UNAVAILABLE', this.keyProblem ?? MASTER_KEY_MISSING);
    return this.current;
  }

  private row(scope: string, purpose: SecretPurpose): Row | undefined {
    return this.db.prepare('SELECT * FROM secrets WHERE scope = ? AND purpose = ?').get(scope, purpose) as
      Row | undefined;
  }

  private rows(): Row[] {
    return this.db.prepare('SELECT * FROM secrets ORDER BY scope, purpose').all() as Row[];
  }

  private openRow(
    r: Row,
  ):
    | { readonly ok: true; readonly value: string }
    | { readonly ok: false; readonly reason: UnreadableReason; readonly message: string } {
    const keys = [this.current, this.previous].filter((k): k is MasterKey => k !== null);
    const byId = keys.find((k) => k.id === r.key_id);
    if (byId) {
      const value = open(byId, r.scope, r.purpose, r);
      if (value !== undefined) return { ok: true, value };
      return {
        ok: false,
        reason: 'damaged',
        message:
          'the stored value does not authenticate (damaged, or copied from another row); set it again or restore a backup',
      };
    }
    if (!this.current) {
      return { ok: false, reason: 'no_master_key', message: this.keyProblem ?? MASTER_KEY_MISSING };
    }
    return {
      ok: false,
      reason: 'wrong_master_key',
      message:
        'it was sealed with another master key than SECRETS_MASTER_KEY (put the right key back, or set the old one as SECRETS_MASTER_KEY_PREVIOUS)',
    };
  }

  private toMeta(r: Row): SecretMeta {
    return {
      scope: r.scope,
      purpose: r.purpose,
      hint: r.hint,
      source: r.source,
      sealedWith:
        this.current && r.key_id === this.current.id
          ? 'current'
          : this.previous && r.key_id === this.previous.id
            ? 'previous'
            : 'unknown',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

/** For tests and tools: a store on `db` with the given master key. */
export function openSecretStore(db: Db, keys: SecretKeys, now?: () => number): SecretStore {
  return new SecretStore(db, keys, now);
}
