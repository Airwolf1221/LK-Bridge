import { hashSecret, randomToken } from './crypto.js';
import type { AuthEventLogger } from './events.js';
import { SCOPE_MCP, formatScope } from './scopes.js';
import type { AuthStore, PatRecord } from './store.js';

/**
 * Personal access tokens: long-lived bearer tokens for Claude Code (`-H "Authorization: Bearer"`).
 * The token is shown once at creation; only its SHA-256 is stored.
 */

export const PAT_PREFIX = 'lkb_pat_';

export interface PatView {
  readonly id: string;
  readonly name: string;
  readonly hint: string;
  readonly scope: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly lastUsedAt: number | null;
}

export interface CreatedPat {
  /** The secret. Show it once; it cannot be recovered. */
  readonly token: string;
  readonly pat: PatView;
}

const view = (p: PatRecord): PatView => ({
  id: p.id,
  name: p.name,
  hint: p.tokenHint,
  scope: p.scope,
  createdAt: p.createdAt,
  expiresAt: p.expiresAt,
  revokedAt: p.revokedAt,
  lastUsedAt: p.lastUsedAt,
});

export class PatService {
  constructor(
    private readonly deps: {
      readonly store: AuthStore;
      readonly event: AuthEventLogger;
      readonly now: () => number;
    },
  ) {}

  create(input: { readonly name: string; readonly expiresInDays?: number }): CreatedPat {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 100) throw new Error('PAT name must be 1-100 characters');
    if (
      input.expiresInDays !== undefined &&
      !(Number.isInteger(input.expiresInDays) && input.expiresInDays > 0)
    ) {
      throw new Error('expiresInDays must be a positive whole number');
    }
    const token = `${PAT_PREFIX}${randomToken(32)}`;
    const id = `pat_${randomToken(9)}`;
    const now = this.deps.now();
    const record = {
      id,
      name,
      tokenHash: hashSecret(token),
      tokenHint: token.slice(-4),
      scope: formatScope([SCOPE_MCP]),
      createdAt: now,
      expiresAt: input.expiresInDays !== undefined ? now + input.expiresInDays * 86400 : null,
    };
    this.deps.store.insertPat(record);
    this.deps.event('pat.created', { pat_id: id, name, expires_at: record.expiresAt });
    return { token, pat: view({ ...record, revokedAt: null, lastUsedAt: null }) };
  }

  list(): PatView[] {
    return this.deps.store.listPats().map(view);
  }

  revoke(id: string): boolean {
    const done = this.deps.store.revokePat(id, this.deps.now());
    if (done) this.deps.event('pat.revoked', { pat_id: id });
    return done;
  }

  /** Returns the active PAT for a presented token, or undefined. */
  verify(token: string): PatView | undefined {
    if (!token.startsWith(PAT_PREFIX) || token.length > 200) return undefined;
    const rec = this.deps.store.getPatByHash(hashSecret(token));
    const now = this.deps.now();
    if (!rec || rec.revokedAt !== null || (rec.expiresAt !== null && rec.expiresAt <= now)) return undefined;
    if (rec.lastUsedAt === null || now - rec.lastUsedAt >= 60) this.deps.store.touchPat(rec.id, now);
    return view(rec);
  }
}
