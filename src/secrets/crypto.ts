/**
 * The secret store's cryptography (OPS2, ADR 0028): AES-256-GCM with a random 96-bit nonce per value, and the row's
 * scope and purpose as associated data, so a ciphertext only opens in the row it was written to.
 *
 * The AES key is derived from SECRETS_MASTER_KEY with HKDF-SHA256; the key id stored beside each row is derived with a
 * different HKDF label, so it names the master key without revealing anything about the AES key.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/** SECRETS_MASTER_KEY must be at least this long (env-sync generates 32 random bytes, base64: 44 characters). */
export const MIN_MASTER_KEY_LENGTH = 32;

export interface MasterKey {
  /** 16 hex characters naming the master key (a one-way fingerprint, safe to store and show). */
  readonly id: string;
  readonly key: Buffer;
}

const SALT = 'lk-bridge secret store';

export function deriveMasterKey(raw: string): MasterKey {
  const ikm = Buffer.from(raw.trim(), 'utf8');
  const key = Buffer.from(hkdfSync('sha256', ikm, SALT, 'aes-256-gcm v1', 32));
  const id = Buffer.from(hkdfSync('sha256', ikm, SALT, 'key id v1', 8)).toString('hex');
  return { id, key };
}

export interface Sealed {
  readonly keyId: string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

/** The associated data: the row a value belongs to. */
export function associatedData(scope: string, purpose: string): Buffer {
  return Buffer.from(`lk-bridge secret v1\0${scope}\0${purpose}`, 'utf8');
}

export function seal(mk: MasterKey, scope: string, purpose: string, plaintext: string): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', mk.key, nonce);
  cipher.setAAD(associatedData(scope, purpose));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { keyId: mk.id, nonce, ciphertext, tag: cipher.getAuthTag() };
}

/** Opens a sealed value, or returns undefined when it does not authenticate (wrong key, wrong row, damaged). */
export function open(
  mk: MasterKey,
  scope: string,
  purpose: string,
  s: Omit<Sealed, 'keyId'>,
): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', mk.key, s.nonce);
    decipher.setAAD(associatedData(scope, purpose));
    decipher.setAuthTag(s.tag);
    return Buffer.concat([decipher.update(s.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * A one-way, domain-separated SHA-256 of an env value, recorded when it is imported. The values are high-entropy keys,
 * secrets and Argon2id hashes, so this reveals nothing usable; it lets the bridge recognise the same value later.
 */
export function envValueDigest(variable: string, value: string): string {
  return createHash('sha256').update(`lk-bridge env import v1\0${variable}\0${value}`, 'utf8').digest('hex');
}

/** The last four characters of an API key: all the dashboard ever shows of a stored key. */
export function keyHint(key: string): string {
  return key.slice(-4);
}
