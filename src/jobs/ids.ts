/**
 * Identifiers minted by the bridge.
 *
 * - Client-chosen LK ids (PLAN §1.1, §5.3): a cuid2-shaped id, 8 or 24 characters, a lowercase letter followed by
 *   lowercase letters or digits (LK's pattern `^[a-z](?:[0-9a-z]{7}|[0-9a-z]{23})$`). The engine mints one for every
 *   create that accepts it and persists it in the step before the first send.
 * - Job ids: `j` + 15 base-36 characters, safe inside idempotency keys and request ids.
 */
import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
export const CLIENT_ID_PATTERN = /^[a-z](?:[0-9a-z]{7}|[0-9a-z]{23})$/;

let counter = randomBytes(4).readUInt32BE(0);

function base36(seed: Buffer, length: number): string {
  let out = '';
  let bytes = seed;
  let i = 0;
  while (out.length < length) {
    if (i >= bytes.length) {
      bytes = randomBytes(32);
      i = 0;
    }
    const b = bytes[i++]!;
    // Rejection sampling keeps the alphabet uniform (252 = 7 * 36).
    if (b < 252) out += ALPHABET[b % 36];
  }
  return out;
}

/**
 * A cuid2-style id: a random lowercase letter, then a hash of time, a process counter and fresh entropy, in base 36.
 * Collisions are as unlikely as for cuid2 itself (≥ 119 bits of entropy at length 24).
 */
export function mintClientId(length: 8 | 24 = 24): string {
  const first = LETTERS[randomBytes(1)[0]! % 26]!;
  counter = (counter + 1) >>> 0;
  const hash = createHash('sha512')
    .update(`${Date.now()}:${counter}:`)
    .update(randomBytes(32))
    .digest();
  return first + base36(hash, length - 1);
}

export function isClientId(id: unknown): id is string {
  return typeof id === 'string' && CLIENT_ID_PATTERN.test(id);
}

export function newJobId(): string {
  return `j${base36(randomBytes(24), 15)}`;
}

export function newArtifactId(): string {
  return `a${base36(randomBytes(24), 15)}`;
}
