import argon2 from 'argon2';

/**
 * Owner password hashing: Argon2id with the library defaults (64 MiB, t=3, p=4), above the
 * OWASP minimum. Only the PHC string is ever stored, in the environment file.
 */
export interface Argon2Cost {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export const DEFAULT_ARGON2_COST: Argon2Cost = { memoryCost: 65536, timeCost: 3, parallelism: 4 };

export function hashPassword(password: string, cost: Argon2Cost = DEFAULT_ARGON2_COST): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, ...cost });
}

/** Verifies `password` against a PHC hash. Never throws for a malformed hash; returns false. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
