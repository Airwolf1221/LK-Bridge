import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random string with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Hash for high-entropy secrets (codes, refresh tokens, PATs, client secrets, session ids).
 * They carry at least 256 bits of entropy, so an unkeyed SHA-256 is enough and keeps stored
 * credentials valid across a rotation of the signing secrets.
 */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))). */
export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** RFC 7636 §4.1: 43-128 characters from the unreserved set. */
export const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** An S256 challenge is the base64url of a 32-byte digest: exactly 43 characters. */
export const CODE_CHALLENGE_S256 = /^[A-Za-z0-9_-]{43}$/;

export interface KeyRing {
  /** HMAC key for CSRF tokens. */
  readonly csrf: Buffer;
  /** HS256 key for access-token JWTs. */
  readonly jwt: Uint8Array;
}

/** Derives independent purpose-bound keys from the configured secrets (HKDF-SHA256). */
export function deriveKeys(sessionSecret: string, jwtSigningKey: string): KeyRing {
  const derive = (ikm: string, info: string) =>
    Buffer.from(hkdfSync('sha256', Buffer.from(ikm, 'utf8'), 'lk-bridge', info, 32));
  return {
    csrf: derive(sessionSecret, 'lk-bridge csrf v1'),
    jwt: new Uint8Array(derive(jwtSigningKey, 'lk-bridge access-token hs256 v1')),
  };
}

export function hmac(key: Buffer, ...parts: string[]): string {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p, 'utf8').update('\0');
  return h.digest('base64url');
}
