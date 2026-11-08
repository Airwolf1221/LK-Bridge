/**
 * Client key sets for `private_key_jwt` (RFC 7523 §2.2, RFC 7591 `jwks_uri` / `jwks`, ADR 0021): the signing
 * algorithms the bridge accepts, and the checks a client's JSON Web Key Set must pass before any key in it is used.
 * Nothing here fetches; see `client-assertion.ts`.
 */

/**
 * Asymmetric algorithms only, never `none` or HS*: an HMAC assertion would need a shared secret, and the bridge has no
 * client secrets for CIMD clients. Advertised as `token_endpoint_auth_signing_alg_values_supported`.
 */
export const ASSERTION_SIGNING_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
] as const;

export type AssertionAlg = (typeof ASSERTION_SIGNING_ALGS)[number];

export function isAssertionAlg(value: unknown): value is AssertionAlg {
  return typeof value === 'string' && (ASSERTION_SIGNING_ALGS as readonly string[]).includes(value);
}

/** A public RSA or EC key from a client's key set, as published (JWK members kept for `importJWK`). */
export interface PublicJwk {
  readonly kty: 'RSA' | 'EC';
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly key_ops?: readonly string[];
  readonly crv?: string;
  readonly [member: string]: unknown;
}

export class JwksShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwksShapeError';
  }
}

const MAX_KEYS = 20;
/** Private RSA and EC members: a key set that publishes one of these is refused outright. */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'] as const;
const EC_CURVES = new Set(['P-256', 'P-384', 'P-521']);

/**
 * Validates a JWK Set (RFC 7517 §5) and returns its usable public signing keys. Symmetric (`oct`) keys and key types
 * the bridge does not verify with are skipped; a key with private members makes the whole set unusable, because a
 * client that publishes its private key has no key worth trusting. Throws {@link JwksShapeError}.
 */
export function parseJwks(body: unknown): PublicJwk[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new JwksShapeError('key set must be a JSON object with a "keys" array');
  }
  const keys = (body as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) throw new JwksShapeError('key set must be a JSON object with a "keys" array');
  if (keys.length === 0) throw new JwksShapeError('key set has no keys');
  if (keys.length > MAX_KEYS) throw new JwksShapeError(`key set has more than ${MAX_KEYS} keys`);
  const usable: PublicJwk[] = [];
  for (const key of keys) {
    if (typeof key !== 'object' || key === null || Array.isArray(key)) {
      throw new JwksShapeError('every key in the key set must be a JSON object');
    }
    const k = key as Record<string, unknown>;
    if (k.kty === 'RSA' || k.kty === 'EC') {
      if (PRIVATE_MEMBERS.some((m) => m in k)) {
        throw new JwksShapeError('key set contains private key material');
      }
    }
    if (k.kid !== undefined && (typeof k.kid !== 'string' || k.kid.length > 256)) {
      throw new JwksShapeError('a key in the key set has an invalid "kid"');
    }
    if (k.kty === 'RSA' && typeof k.n === 'string' && typeof k.e === 'string') {
      usable.push(k as PublicJwk);
    } else if (
      k.kty === 'EC' &&
      typeof k.crv === 'string' &&
      EC_CURVES.has(k.crv) &&
      typeof k.x === 'string' &&
      typeof k.y === 'string'
    ) {
      usable.push(k as PublicJwk);
    }
  }
  if (usable.length === 0) throw new JwksShapeError('key set has no usable public RSA or EC signing key');
  return usable;
}

const CURVE_FOR_ALG: Readonly<Record<string, string>> = { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' };

/** Whether a key may verify a signature made with `alg` (key type, curve, and its own `alg`, `use`, `key_ops`). */
export function keyFitsAlg(jwk: PublicJwk, alg: AssertionAlg): boolean {
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  if (jwk.use !== undefined && jwk.use !== 'sig') return false;
  if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes('verify'))) {
    return false;
  }
  if (alg.startsWith('RS') || alg.startsWith('PS')) return jwk.kty === 'RSA';
  return jwk.kty === 'EC' && jwk.crv === CURVE_FOR_ALG[alg];
}

/** Validates a `jwks_uri`: an absolute https URL without credentials or a fragment. Returns the reason, or null. */
export function jwksUriProblem(value: string): string | null {
  if (value.length > 2048) return 'jwks_uri is too long';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'jwks_uri is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'jwks_uri must use https';
  if (url.username || url.password) return 'jwks_uri must not contain credentials';
  if (value.includes('#')) return 'jwks_uri must not contain a fragment';
  return null;
}
