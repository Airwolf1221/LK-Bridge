/**
 * Persistence of the policy layer (migration 0300_policy_init.sql): profiles, the default scope, principal lookup
 * (grant or PAT → profile → live scope), the audit log and policy events.
 *
 * Principal lookup reads chunk 4's auth tables (`auth_token_families`, `auth_pats`, `auth_clients`) read-only; the
 * only auth columns this layer writes are the `profile_id` links added by migration 0300.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';
import type { JobEventEmitter, JobEngineEvents } from '../jobs/events.js';
import { PolicyError } from './errors.js';
import {
  isProfileKind,
  isScope,
  type Profile,
  type ProfileKind,
  type ResolvedPrincipal,
  type Scope,
} from './types.js';

type Row = Record<string, unknown>;

const DEFAULT_SCOPE_KEY = 'default_scope';
/** Labels people type: letters, digits, space, `.`, `_`, `-`; starts with a letter or digit. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
/** Profile labels that would be confused with internal principals. */
const RESERVED_LABELS = new Set(['system', 'owner']);

export function newProfileId(): string {
  return `prof_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').toLowerCase()}`;
}

export function validateLabel(label: unknown): string {
  if (typeof label !== 'string') throw new PolicyError('INVALID_INPUT', 'A profile label is required');
  const l = label.trim();
  if (!LABEL.test(l)) {
    throw new PolicyError(
      'INVALID_INPUT',
      'A profile label is 1-64 characters: letters, digits, spaces, dots, underscores and hyphens',
    );
  }
  if (RESERVED_LABELS.has(l.toLowerCase())) {
    throw new PolicyError('INVALID_INPUT', `"${l}" is reserved; choose another label`);
  }
  return l;
}

function toProfile(r: Row): Profile {
  return {
    id: String(r.id),
    label: String(r.label),
    kind: r.kind as ProfileKind,
    scope: r.scope as Scope,
    showLowLevelTools: Number(r.show_low_level_tools ?? 0) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export interface AuditRow {
  readonly id: number;
  readonly at: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  readonly before: unknown;
  readonly after: unknown;
}

/** A grant or PAT as the owner sees it in "Clients & Access". Auth times are converted to milliseconds. */
export interface ConnectionView {
  readonly id: string;
  readonly type: 'grant' | 'pat';
  /** OAuth client name (self-reported, untrusted) or the PAT's name. */
  readonly label: string;
  readonly clientId: string | null;
  readonly profileId: string | null;
  readonly profile: string | null;
  readonly scope: Scope | null;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly active: boolean;
}

const ms = (seconds: unknown): number | null =>
  seconds === null || seconds === undefined ? null : Number(seconds) * 1000;

export class PolicyStore {
  private changeCounter = 0;
  private readonly emitters = new Set<JobEventEmitter>();

  constructor(
    readonly db: Db,
    readonly now: () => number = () => Date.now(),
  ) {}

  /** Increments on every change made through this store; caches compare it to stay live. */
  get version(): number {
    return this.changeCounter;
  }

  /** Marks policy state as changed (clears every cache at once). */
  bump(): void {
    this.changeCounter++;
  }

  /** Events go to every attached emitter (the job engine's, so the dashboard has one stream). */
  attachEmitter(e: JobEventEmitter): () => void {
    this.emitters.add(e);
    return () => this.emitters.delete(e);
  }

  emit<E extends 'policy' | 'proposal'>(name: E, payload: JobEngineEvents[E]): void {
    for (const e of this.emitters) e.emit(name, payload);
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ------------------------------------------------------------------------------------------ profiles

  listProfiles(): Profile[] {
    return (this.db.prepare('SELECT * FROM agent_profiles ORDER BY label COLLATE NOCASE').all() as Row[]).map(
      toProfile,
    );
  }

  getProfile(id: string): Profile | undefined {
    const r = this.db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id) as Row | undefined;
    return r ? toProfile(r) : undefined;
  }

  getProfileByLabel(label: string): Profile | undefined {
    const r = this.db
      .prepare('SELECT * FROM agent_profiles WHERE label = ? COLLATE NOCASE')
      .get(label.trim()) as Row | undefined;
    return r ? toProfile(r) : undefined;
  }

  /** Low-level insert; owner commands add the audit row. Scope defaults to the default scope for new connections. */
  insertProfile(input: { label: string; kind: ProfileKind; scope?: Scope }): Profile {
    const label = validateLabel(input.label);
    if (!isProfileKind(input.kind))
      throw new PolicyError('INVALID_INPUT', `Unknown profile kind: ${String(input.kind)}`);
    const scope = input.scope ?? this.defaultScope();
    if (!isScope(scope)) throw new PolicyError('INVALID_INPUT', `Unknown scope: ${String(scope)}`);
    if (this.getProfileByLabel(label)) {
      throw new PolicyError('PROFILE_EXISTS', `A profile labelled "${label}" already exists`);
    }
    const now = this.now();
    const id = newProfileId();
    this.db
      .prepare(
        'INSERT INTO agent_profiles (id, label, kind, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, label, input.kind, scope, now, now);
    this.bump();
    return this.getProfile(id)!;
  }

  updateScope(id: string, scope: Scope): { before: Profile; after: Profile } {
    if (!isScope(scope)) throw new PolicyError('INVALID_INPUT', `Unknown scope: ${String(scope)}`);
    const before = this.getProfile(id);
    if (!before) throw new PolicyError('PROFILE_NOT_FOUND', `No profile ${id}`);
    this.db
      .prepare('UPDATE agent_profiles SET scope = ?, updated_at = ? WHERE id = ?')
      .run(scope, this.now(), id);
    this.bump();
    return { before, after: this.getProfile(id)! };
  }

  /** v2 B2: shows or hides the low-level tools for a profile's connections (applies at the next tools/list). */
  updateShowLowLevelTools(id: string, show: boolean): { before: Profile; after: Profile } {
    const before = this.getProfile(id);
    if (!before) throw new PolicyError('PROFILE_NOT_FOUND', `No profile ${id}`);
    this.db
      .prepare('UPDATE agent_profiles SET show_low_level_tools = ?, updated_at = ? WHERE id = ?')
      .run(show ? 1 : 0, this.now(), id);
    this.bump();
    return { before, after: this.getProfile(id)! };
  }

  // ------------------------------------------------------------------------------------------ settings

  /** The scope a new profile gets unless one is chosen (default `read`). */
  defaultScope(): Scope {
    const r = this.db.prepare('SELECT value FROM policy_settings WHERE key = ?').get(DEFAULT_SCOPE_KEY) as
      { value: string } | undefined;
    const v = r ? (JSON.parse(r.value) as unknown) : undefined;
    return isScope(v) ? v : 'read';
  }

  writeDefaultScope(scope: Scope, by: string): void {
    if (!isScope(scope)) throw new PolicyError('INVALID_INPUT', `Unknown scope: ${String(scope)}`);
    this.db
      .prepare(
        `INSERT INTO policy_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      )
      .run(DEFAULT_SCOPE_KEY, JSON.stringify(scope), this.now(), by);
    this.bump();
  }

  // ------------------------------------------------------------------------------------------ principals

  /**
   * The principal behind a grant (`grant_…`, an OAuth token family) or PAT (`pat_…`) id, with its profile's scope
   * as stored now. Undefined for anything else, or when the grant or PAT has no profile.
   */
  lookupPrincipal(principalId: string): ResolvedPrincipal | undefined {
    const nowSec = Math.floor(this.now() / 1000);
    if (principalId.startsWith('grant_')) {
      const r = this.db
        .prepare(
          `SELECT f.family_id, f.client_id, f.revoked_at, f.expires_at, c.client_name,
                  p.id AS profile_id, p.label AS profile_label, p.scope AS profile_scope, p.show_low_level_tools AS profile_low
           FROM auth_token_families f
           LEFT JOIN auth_clients c ON c.client_id = f.client_id
           LEFT JOIN agent_profiles p ON p.id = f.profile_id
           WHERE f.family_id = ?`,
        )
        .get(principalId) as Row | undefined;
      if (!r || r.profile_id === null || r.profile_id === undefined) return undefined;
      const name =
        typeof r.client_name === 'string' && r.client_name !== '' ? r.client_name : String(r.client_id);
      return {
        principal: {
          principalId,
          profile: String(r.profile_label),
          label: `${name.slice(0, 80)} (OAuth)`,
        },
        profileId: r.profile_id as string,
        scope: r.profile_scope as Scope,
        showLowLevelTools: Number(r.profile_low ?? 0) === 1,
        active: r.revoked_at === null && Number(r.expires_at) > nowSec,
      };
    }
    if (principalId.startsWith('pat_')) {
      const r = this.db
        .prepare(
          `SELECT t.id, t.name, t.revoked_at, t.expires_at,
                  p.id AS profile_id, p.label AS profile_label, p.scope AS profile_scope, p.show_low_level_tools AS profile_low
           FROM auth_pats t LEFT JOIN agent_profiles p ON p.id = t.profile_id WHERE t.id = ?`,
        )
        .get(principalId) as Row | undefined;
      if (!r || r.profile_id === null || r.profile_id === undefined) return undefined;
      return {
        principal: {
          principalId,
          profile: String(r.profile_label),
          label: `${String(r.name).slice(0, 80)} (PAT)`,
        },
        profileId: r.profile_id as string,
        scope: r.profile_scope as Scope,
        showLowLevelTools: Number(r.profile_low ?? 0) === 1,
        active: r.revoked_at === null && (r.expires_at === null || Number(r.expires_at) > nowSec),
      };
    }
    return undefined;
  }

  /** Every grant and PAT, newest first, with its profile and last use. */
  listConnections(): ConnectionView[] {
    const nowSec = Math.floor(this.now() / 1000);
    const grants = (
      this.db
        .prepare(
          `SELECT f.*, c.client_name, p.label AS profile_label, p.scope AS profile_scope,
                  (SELECT MAX(a.last_used_at) FROM auth_access_tokens a WHERE a.family_id = f.family_id) AS at_used
           FROM auth_token_families f
           LEFT JOIN auth_clients c ON c.client_id = f.client_id
           LEFT JOIN agent_profiles p ON p.id = f.profile_id`,
        )
        .all() as Row[]
    ).map((r): ConnectionView => ({
      id: String(r.family_id),
      type: 'grant',
      label: typeof r.client_name === 'string' && r.client_name !== '' ? r.client_name : String(r.client_id),
      clientId: String(r.client_id),
      profileId: (r.profile_id as string | null) ?? null,
      profile: (r.profile_label as string | null) ?? null,
      scope: (r.profile_scope as Scope | null) ?? null,
      createdAt: Number(r.created_at) * 1000,
      lastUsedAt: ms(maxOf(r.last_used_at, r.at_used)),
      expiresAt: ms(r.expires_at),
      revokedAt: ms(r.revoked_at),
      active: r.revoked_at === null && Number(r.expires_at) > nowSec,
    }));
    const pats = (
      this.db
        .prepare(
          `SELECT t.*, p.label AS profile_label, p.scope AS profile_scope
           FROM auth_pats t LEFT JOIN agent_profiles p ON p.id = t.profile_id`,
        )
        .all() as Row[]
    ).map((r): ConnectionView => ({
      id: String(r.id),
      type: 'pat',
      label: String(r.name),
      clientId: null,
      profileId: (r.profile_id as string | null) ?? null,
      profile: (r.profile_label as string | null) ?? null,
      scope: (r.profile_scope as Scope | null) ?? null,
      createdAt: Number(r.created_at) * 1000,
      lastUsedAt: ms(r.last_used_at),
      expiresAt: ms(r.expires_at),
      revokedAt: ms(r.revoked_at),
      active: r.revoked_at === null && (r.expires_at === null || Number(r.expires_at) > nowSec),
    }));
    return [...grants, ...pats].sort((a, b) => b.createdAt - a.createdAt);
  }

  // ------------------------------------------------------------------------------------------ audit

  /** Writes one audit row and emits the matching `policy` event. */
  audit(actor: string, action: string, target: string | null, before?: unknown, after?: unknown): void {
    this.db
      .prepare('INSERT INTO audit_log (at, actor, action, target, before, after) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        this.now(),
        actor,
        action,
        target,
        before === undefined ? null : JSON.stringify(before),
        after === undefined ? null : JSON.stringify(after),
      );
    this.emit('policy', {
      action,
      actor,
      target,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  }

  listAudit(filter: { limit?: number; before?: number; action?: string } = {}): AuditRow[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filter.before !== undefined) {
      where.push('at < ?');
      vals.push(filter.before);
    }
    if (filter.action) {
      where.push('action = ?');
      vals.push(filter.action);
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      )
      .all(...vals, limit) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      actor: String(r.actor),
      action: String(r.action),
      target: (r.target as string | null) ?? null,
      before: r.before === null ? null : (JSON.parse(r.before as string) as unknown),
      after: r.after === null ? null : (JSON.parse(r.after as string) as unknown),
    }));
  }
}

function maxOf(a: unknown, b: unknown): number | null {
  const xs = [a, b].filter((v) => v !== null && v !== undefined).map(Number);
  return xs.length ? Math.max(...xs) : null;
}
