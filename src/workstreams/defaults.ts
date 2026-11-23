/**
 * v3 F5c (ADR 0069, H8): a connection's default workstream label (`bridge_workstream { set }`), held on the server so
 * an agent that forgets the `workstream` argument is still grouped. It expires after 12 hours of no use: a write that
 * takes it, or `bridge_workstream` itself, counts as use.
 */
import type { Db } from '../db/open.js';
import { normaliseWorkstream } from './context.js';

/** How long a default lasts without use. */
export const DEFAULT_TTL_MS = 12 * 3_600_000;

export interface WorkstreamDefault {
  readonly label: string;
  readonly setAt: number;
  readonly lastUsedAt: number;
  /** When it lapses unless used again. */
  readonly expiresAt: number;
}

export class WorkstreamDefaults {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Sets (or, with null, clears) a connection's default. Returns the default now in force. */
  set(principalId: string, label: string | null): WorkstreamDefault | null {
    const l = normaliseWorkstream(label);
    if (l === null) {
      this.db.prepare('DELETE FROM workstream_defaults WHERE principal_id = ?').run(principalId);
      return null;
    }
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO workstream_defaults (principal_id, label, set_at, last_used_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (principal_id) DO UPDATE SET label = excluded.label, set_at = excluded.set_at,
           last_used_at = excluded.last_used_at`,
      )
      .run(principalId, l, at, at);
    return { label: l, setAt: at, lastUsedAt: at, expiresAt: at + this.ttlMs };
  }

  /** The default in force (null: none, or lapsed: a lapsed one is removed). `touch`: this counts as use. */
  get(principalId: string, o: { readonly touch?: boolean } = {}): WorkstreamDefault | null {
    const r = this.db
      .prepare('SELECT label, set_at, last_used_at FROM workstream_defaults WHERE principal_id = ?')
      .get(principalId) as { label: string; set_at: number; last_used_at: number } | undefined;
    if (!r) return null;
    const at = this.now();
    if (at - r.last_used_at >= this.ttlMs) {
      this.db.prepare('DELETE FROM workstream_defaults WHERE principal_id = ?').run(principalId);
      return null;
    }
    let used = r.last_used_at;
    if (o.touch) {
      this.db
        .prepare('UPDATE workstream_defaults SET last_used_at = ? WHERE principal_id = ?')
        .run(at, principalId);
      used = at;
    }
    return { label: r.label, setAt: r.set_at, lastUsedAt: used, expiresAt: used + this.ttlMs };
  }

  /** Removes every lapsed default (housekeeping; `get` also does it one at a time). */
  prune(): number {
    return this.db
      .prepare('DELETE FROM workstream_defaults WHERE last_used_at <= ?')
      .run(this.now() - this.ttlMs).changes;
  }
}
