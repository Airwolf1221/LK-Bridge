/**
 * The owner's credentials (OPS2, ADR 0028, docs/auth.md): the Argon2id password hash and the authenticator (TOTP)
 * secret, kept in the encrypted secret store, plus the authenticator's recovery codes (hashed).
 *
 * - On the first start with a master key, OWNER_PASSWORD_HASH and OWNER_TOTP_SECRET from the env file are imported
 *   into the store, once each (`secret_imports`). From then on the store's values are the ones used: a password changed
 *   or an authenticator removed on the dashboard stays so, whatever the env file still says (with a warning).
 * - Without a usable store (no SECRETS_MASTER_KEY), the env file's values are used, as before OPS2, as long as nothing
 *   is stored. A stored value that cannot be read (wrong or missing master key) is NOT replaced by the env file's: sign-in
 *   refuses with a clear reason instead (fail closed), so a lost key can never switch the authenticator off.
 * - Recovery codes: ten single-use codes of 100 random bits each, shown once, stored as SHA-256 (they are too long to
 *   guess, so an unkeyed hash is enough; it also keeps them valid across a rotation of the master key).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';
import { OWNER_SCOPE, SecretStoreError, type SecretPurpose, type SecretStore } from '../secrets/store.js';
import { base32Encode } from './totp.js';

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE = /^[A-Z2-7]{20}$/;
/** An enrolment waits this long for its confirming code. */
const PENDING_TOTP_SECONDS = 600;

export type PasswordLookup =
  | { readonly ok: true; readonly hash: string; readonly source: 'store' | 'env' }
  | { readonly ok: false; readonly reason: string };

export type TotpLookup =
  | { readonly state: 'off' }
  | { readonly state: 'on'; readonly secret: string; readonly source: 'store' | 'env' }
  /** Stored but unreadable: sign-in refuses (fail closed). */
  | { readonly state: 'unreadable'; readonly reason: string };

export interface OwnerCredentialsOptions {
  readonly db: Db;
  /** The encrypted store; undefined in tests that build the auth surface alone (env values only, as in v1). */
  readonly store?: SecretStore | undefined;
  readonly env: { readonly passwordHash?: string | undefined; readonly totpSecret?: string | undefined };
  /** Unix seconds. */
  readonly now: () => number;
  readonly log?: (fields: Record<string, unknown>, msg: string) => void;
}

const VARS: readonly (readonly [string, SecretPurpose, 'passwordHash' | 'totpSecret'])[] = [
  ['OWNER_PASSWORD_HASH', 'owner_password_hash', 'passwordHash'],
  ['OWNER_TOTP_SECRET', 'owner_totp_secret', 'totpSecret'],
];

/** `ABCDE-FGHIJ-KLMNO-PQRST`, or undefined for anything that is not a recovery code. */
export function normaliseRecoveryCode(input: string): string | undefined {
  const s = input.replace(/[\s-]+/g, '').toUpperCase();
  return RECOVERY_CODE.test(s) ? s : undefined;
}

function recoveryHash(normalised: string): string {
  return createHash('sha256').update(`lk-bridge recovery code v1\0${normalised}`, 'utf8').digest('hex');
}

export class OwnerCredentials {
  private readonly pending = new Map<string, { secret: string; expiresAt: number }>();

  constructor(private readonly o: OwnerCredentialsOptions) {}

  /** The store, when it can be written. */
  get store(): SecretStore | undefined {
    return this.o.store?.available ? this.o.store : undefined;
  }

  /** The store is there at all (it may still be unusable: see `storeProblem`). */
  get hasStore(): boolean {
    return this.o.store !== undefined;
  }

  /**
   * Imports OWNER_PASSWORD_HASH and OWNER_TOTP_SECRET from the env file into the store, once each. Returns the names
   * imported (never a value). Does nothing without a usable store.
   */
  importFromEnv(): string[] {
    const store = this.store;
    if (!store) return [];
    const imported: string[] = [];
    for (const [variable, purpose, field] of VARS) {
      const value = this.o.env[field];
      if (!value || store.imported(variable) !== undefined || store.has(OWNER_SCOPE, purpose)) continue;
      this.o.db.transaction(() => {
        store.write(OWNER_SCOPE, purpose, value, { source: 'env_import' });
        store.recordImport(variable, OWNER_SCOPE, purpose, value);
      })();
      imported.push(variable);
      this.o.log?.({ variable }, 'owner credential imported from the env file into the encrypted store');
    }
    return imported;
  }

  password(): PasswordLookup {
    const s = this.o.store;
    if (s) {
      const r = s.read(OWNER_SCOPE, 'owner_password_hash');
      if (r.ok) return { ok: true, hash: r.value, source: 'store' };
      if (r.reason !== 'not_stored') {
        return {
          ok: false,
          reason: `The owner password is kept in the encrypted store, which cannot be read: ${r.message}`,
        };
      }
    }
    if (this.o.env.passwordHash) return { ok: true, hash: this.o.env.passwordHash, source: 'env' };
    return {
      ok: false,
      reason:
        'No owner password is set. Run `npm run setup:owner` on the server and put the OWNER_PASSWORD_HASH line it prints in the env file.',
    };
  }

  totp(): TotpLookup {
    const s = this.o.store;
    if (s) {
      const r = s.read(OWNER_SCOPE, 'owner_totp_secret');
      if (r.ok) return { state: 'on', secret: r.value, source: 'store' };
      if (r.reason !== 'not_stored') {
        return {
          state: 'unreadable',
          reason: `The authenticator secret is kept in the encrypted store, which cannot be read: ${r.message}`,
        };
      }
      // Imported once and since removed on the dashboard: off, whatever the env file still says.
      if (s.imported('OWNER_TOTP_SECRET') !== undefined) return { state: 'off' };
    }
    if (this.o.env.totpSecret) return { state: 'on', secret: this.o.env.totpSecret, source: 'env' };
    return { state: 'off' };
  }

  /** Sign-in asks for a second factor (an unreadable stored secret counts: it fails closed). */
  totpRequired(): boolean {
    return this.totp().state !== 'off';
  }

  // ============================================================================================ changes

  /** Stores a new password hash (the caller hashed it with Argon2id). Throws without a usable store. */
  setPasswordHash(hash: string): void {
    this.requireStore().write(OWNER_SCOPE, 'owner_password_hash', hash, { source: 'dashboard' });
  }

  /** Starts an enrolment for this session: a new secret, held in memory until confirmed (10 minutes). */
  beginTotp(sessionHash: string): string {
    this.requireStore();
    this.sweep();
    const secret = base32Encode(randomBytes(20));
    this.pending.set(sessionHash, { secret, expiresAt: this.o.now() + PENDING_TOTP_SECONDS });
    return secret;
  }

  pendingTotp(sessionHash: string): string | undefined {
    this.sweep();
    return this.pending.get(sessionHash)?.secret;
  }

  /**
   * Enables the authenticator with the session's pending secret (the caller has checked a code against it) and returns
   * a fresh set of recovery codes, shown once. Stored in one transaction.
   */
  enableTotp(sessionHash: string): string[] {
    const store = this.requireStore();
    const p = this.pending.get(sessionHash);
    if (!p || p.expiresAt <= this.o.now()) throw new Error('no pending enrolment');
    this.pending.delete(sessionHash);
    return this.o.db.transaction(() => {
      store.write(OWNER_SCOPE, 'owner_totp_secret', p.secret, { source: 'dashboard' });
      return this.replaceRecoveryCodes();
    })();
  }

  /** Removes the authenticator and its recovery codes. An env OWNER_TOTP_SECRET is never imported after this. */
  disableTotp(): void {
    const store = this.requireStore();
    this.o.db.transaction(() => {
      store.remove(OWNER_SCOPE, 'owner_totp_secret');
      this.o.db.prepare('DELETE FROM owner_recovery_codes').run();
      if (this.o.env.totpSecret && store.imported('OWNER_TOTP_SECRET') === undefined) {
        store.recordImport('OWNER_TOTP_SECRET', OWNER_SCOPE, 'owner_totp_secret', this.o.env.totpSecret);
      }
    })();
  }

  // ============================================================================================ recovery codes

  regenerateRecoveryCodes(): string[] {
    return this.o.db.transaction(() => this.replaceRecoveryCodes())();
  }

  /** Uses up one recovery code (atomically). False for anything else, including a code already used. */
  useRecoveryCode(input: string): boolean {
    const n = normaliseRecoveryCode(input);
    if (!n) return false;
    return (
      this.o.db
        .prepare('UPDATE owner_recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
        .run(this.o.now(), recoveryHash(n)).changes === 1
    );
  }

  recoveryCodesLeft(): number {
    return (
      this.o.db.prepare('SELECT COUNT(*) AS n FROM owner_recovery_codes WHERE used_at IS NULL').get() as {
        n: number;
      }
    ).n;
  }

  // ============================================================================================ status

  /** Differences between the env file and the store, for the dashboard (names only). */
  warnings(): string[] {
    const out: string[] = [];
    const s = this.store;
    if (!s) return out;
    const env = this.o.env;
    if (env.passwordHash && s.has(OWNER_SCOPE, 'owner_password_hash')) {
      if (!s.equals(OWNER_SCOPE, 'owner_password_hash', env.passwordHash)) {
        out.push(
          'OWNER_PASSWORD_HASH in the env file is not the password in use: the one set on the dashboard wins. Retire the env line with `env-sync.sh --retire-imported-keys`.',
        );
      }
    }
    if (env.totpSecret) {
      const t = this.totp();
      if (t.state === 'off') {
        out.push(
          'OWNER_TOTP_SECRET is still in the env file, but the authenticator was removed on the dashboard, so it is not used. Retire the env line with `env-sync.sh --retire-imported-keys`.',
        );
      } else if (t.state === 'on' && !s.equals(OWNER_SCOPE, 'owner_totp_secret', env.totpSecret)) {
        out.push(
          'OWNER_TOTP_SECRET in the env file is not the authenticator in use: the one enrolled on the dashboard wins. Retire the env line with `env-sync.sh --retire-imported-keys`.',
        );
      }
    }
    return out;
  }

  private replaceRecoveryCodes(): string[] {
    this.o.db.prepare('DELETE FROM owner_recovery_codes').run();
    const insert = this.o.db.prepare(
      'INSERT INTO owner_recovery_codes (code_hash, created_at, used_at) VALUES (?, ?, NULL)',
    );
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const raw = base32Encode(randomBytes(13)).slice(0, 20); // 100 bits
      insert.run(recoveryHash(raw), this.o.now());
      codes.push(raw.match(/.{5}/g)!.join('-'));
    }
    return codes;
  }

  private requireStore(): SecretStore {
    const s = this.store;
    if (!s) {
      throw new SecretStoreError(
        'UNAVAILABLE',
        this.o.store?.state().problem ??
          'The encrypted secret store is not set up on this bridge (SECRETS_MASTER_KEY is missing).',
      );
    }
    return s;
  }

  private sweep(): void {
    const now = this.o.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= now) this.pending.delete(k);
  }
}
