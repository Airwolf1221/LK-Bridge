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
import { railsFrom, type WriteRails } from './rails.js';
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
    rails: railsFrom(r.write_rails),
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
  /**
   * Hotfix (ADR 0033): active, and last used (or, never used, created) more than `connections.stale_after_days` ago.
   * Always false when that setting is 0.
   */
  readonly stale: boolean;
}

/** A removed connection's tombstone (migration 1400). Times are Unix milliseconds. */
export interface RemovedConnection {
  readonly id: string;
  readonly type: 'grant' | 'pat';
  readonly label: string;
  readonly clientId: string | null;
  readonly profileId: string | null;
  readonly profileLabel: string | null;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly expiresAt: number | null;
  readonly removedAt: number;
  readonly removedBy: 'owner' | 'system';
}

/**
 * Who a principal id (a grant, a PAT, or `system`) is, for display. History (the journal, proposals, jobs, errors) keeps
 * only the id; this is where it becomes a name, and it still works after the connection was removed (ADR 0033).
 */
export interface PrincipalName {
  readonly id: string;
  /** What to show: "ChatGPT", or "ChatGPT (removed 10 Nov 2026)". Never the bare id, never empty. */
  readonly name: string;
  readonly type: 'grant' | 'pat' | 'system' | 'removed';
  /** Unix milliseconds the connection was removed, or null while it exists. */
  readonly removedAt: number | null;
}

/** `10 Nov 2026`: server-rendered dates always carry the year; British English, in the owner's time zone. */
export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/London',
  });
}

export const AUTO_REMOVE_DAYS_KEY = 'connections.auto_remove_days';
export const STALE_AFTER_DAYS_KEY = 'connections.stale_after_days';
export const DEFAULT_AUTO_REMOVE_DAYS = 30;
export const DEFAULT_STALE_AFTER_DAYS = 14;
const DAY_MS = 86_400_000;

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

  private readonly bumpListeners = new Set<() => void>();

  /** Marks policy state as changed (clears every cache at once). */
  bump(): void {
    this.changeCounter++;
    for (const fn of [...this.bumpListeners]) {
      try {
        fn();
      } catch {
        // A listener that fails never stops a policy change.
      }
    }
  }

  /** Told after every policy change (the tool lists' watch compares what it lists). Returns an unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.bumpListeners.add(fn);
    return () => this.bumpListeners.delete(fn);
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

  /**
   * v3 F3.4 (ADR 0055): a profile's safety rails at scope `write` (applies at the next request; the gate's cache is
   * cleared). Low-level: the owner command audits.
   */
  updateRails(id: string, rails: WriteRails): { before: Profile; after: Profile } {
    const before = this.getProfile(id);
    if (!before) throw new PolicyError('PROFILE_NOT_FOUND', `No profile ${id}`);
    this.db
      .prepare('UPDATE agent_profiles SET write_rails = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(rails), this.now(), id);
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
    this.writeSetting(DEFAULT_SCOPE_KEY, scope, by);
  }

  /** One `policy_settings` value (JSON), or undefined when it was never written. */
  readSetting(key: string): unknown {
    const r = this.db.prepare('SELECT value FROM policy_settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (!r) return undefined;
    try {
      return JSON.parse(r.value) as unknown;
    } catch {
      return undefined;
    }
  }

  writeSetting(key: string, value: unknown, by: string): void {
    this.db
      .prepare(
        `INSERT INTO policy_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      )
      .run(key, JSON.stringify(value), this.now(), by);
    this.bump();
  }

  private daysSetting(key: string, fallback: number): number {
    const v = this.readSetting(key);
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3650 ? v : fallback;
  }

  /** Days after which a revoked or expired connection is removed by the daily sweep; 0 = never. Default 30. */
  autoRemoveDays(): number {
    return this.daysSetting(AUTO_REMOVE_DAYS_KEY, DEFAULT_AUTO_REMOVE_DAYS);
  }

  /** Days of disuse after which an active connection gets the "stale" badge; 0 = never. Default 14. */
  staleAfterDays(): number {
    return this.daysSetting(STALE_AFTER_DAYS_KEY, DEFAULT_STALE_AFTER_DAYS);
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
                  p.id AS profile_id, p.label AS profile_label, p.scope AS profile_scope, p.show_low_level_tools AS profile_low,
                  p.write_rails AS profile_rails
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
        rails: railsFrom(r.profile_rails),
        active: r.revoked_at === null && Number(r.expires_at) > nowSec,
      };
    }
    if (principalId.startsWith('pat_')) {
      const r = this.db
        .prepare(
          `SELECT t.id, t.name, t.revoked_at, t.expires_at,
                  p.id AS profile_id, p.label AS profile_label, p.scope AS profile_scope, p.show_low_level_tools AS profile_low,
                  p.write_rails AS profile_rails
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
        rails: railsFrom(r.profile_rails),
        active: r.revoked_at === null && (r.expires_at === null || Number(r.expires_at) > nowSec),
      };
    }
    return undefined;
  }

  /** Every grant and PAT, newest first, with its profile and last use. */
  listConnections(): ConnectionView[] {
    return this.connections();
  }

  /**
   * CR-2026-11-R4 (LD-03, LD-04): each connection's profile, and nothing else (a light read): the tool lists' watch
   * compares it, since a connection moved to another profile changes what its sessions may use.
   */
  connectionProfiles(): { readonly id: string; readonly profileId: string | null }[] {
    return this.db
      .prepare(
        `SELECT family_id AS id, profile_id AS profileId FROM auth_token_families
         UNION ALL SELECT id, profile_id AS profileId FROM auth_pats`,
      )
      .all() as { id: string; profileId: string | null }[];
  }

  /** One grant or PAT, or undefined. */
  getConnection(id: string): ConnectionView | undefined {
    return this.connections(id)[0];
  }

  private connections(onlyId?: string): ConnectionView[] {
    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    const staleDays = this.staleAfterDays();
    const staleBefore = nowMs - staleDays * DAY_MS;
    const isStale = (active: boolean, createdAt: number, lastUsedAt: number | null) =>
      active && staleDays > 0 && (lastUsedAt ?? createdAt) < staleBefore;
    const grantRows =
      onlyId !== undefined && !onlyId.startsWith('grant_')
        ? []
        : (this.db
            .prepare(
              `SELECT f.*, c.client_name, p.label AS profile_label, p.scope AS profile_scope,
                  (SELECT MAX(a.last_used_at) FROM auth_access_tokens a WHERE a.family_id = f.family_id) AS at_used
           FROM auth_token_families f
           LEFT JOIN auth_clients c ON c.client_id = f.client_id
           LEFT JOIN agent_profiles p ON p.id = f.profile_id
           ${onlyId !== undefined ? 'WHERE f.family_id = ?' : ''}`,
            )
            .all(...(onlyId !== undefined ? [onlyId] : [])) as Row[]);
    const grants = grantRows.map((r): ConnectionView => {
      const active = r.revoked_at === null && Number(r.expires_at) > nowSec;
      const createdAt = Number(r.created_at) * 1000;
      const lastUsedAt = ms(maxOf(r.last_used_at, r.at_used));
      return {
        id: String(r.family_id),
        type: 'grant',
        label:
          typeof r.client_name === 'string' && r.client_name !== '' ? r.client_name : String(r.client_id),
        clientId: String(r.client_id),
        profileId: (r.profile_id as string | null) ?? null,
        profile: (r.profile_label as string | null) ?? null,
        scope: (r.profile_scope as Scope | null) ?? null,
        createdAt,
        lastUsedAt,
        expiresAt: ms(r.expires_at),
        revokedAt: ms(r.revoked_at),
        active,
        stale: isStale(active, createdAt, lastUsedAt),
      };
    });
    const patRows =
      onlyId !== undefined && !onlyId.startsWith('pat_')
        ? []
        : (this.db
            .prepare(
              `SELECT t.*, p.label AS profile_label, p.scope AS profile_scope
           FROM auth_pats t LEFT JOIN agent_profiles p ON p.id = t.profile_id
           ${onlyId !== undefined ? 'WHERE t.id = ?' : ''}`,
            )
            .all(...(onlyId !== undefined ? [onlyId] : [])) as Row[]);
    const pats = patRows.map((r): ConnectionView => {
      const active = r.revoked_at === null && (r.expires_at === null || Number(r.expires_at) > nowSec);
      const createdAt = Number(r.created_at) * 1000;
      const lastUsedAt = ms(r.last_used_at);
      return {
        id: String(r.id),
        type: 'pat',
        label: String(r.name),
        clientId: null,
        profileId: (r.profile_id as string | null) ?? null,
        profile: (r.profile_label as string | null) ?? null,
        scope: (r.profile_scope as Scope | null) ?? null,
        createdAt,
        lastUsedAt,
        expiresAt: ms(r.expires_at),
        revokedAt: ms(r.revoked_at),
        active,
        stale: isStale(active, createdAt, lastUsedAt),
      };
    });
    return [...grants, ...pats].sort((a, b) => b.createdAt - a.createdAt);
  }

  // ------------------------------------------------------------------------------------ removed connections

  insertTombstone(t: RemovedConnection): void {
    this.db
      .prepare(
        `INSERT INTO removed_connections (id, type, label, client_id, profile_id, profile_label, created_at,
           revoked_at, expires_at, removed_at, removed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.type,
        t.label,
        t.clientId,
        t.profileId,
        t.profileLabel,
        t.createdAt,
        t.revokedAt,
        t.expiresAt,
        t.removedAt,
        t.removedBy,
      );
  }

  getTombstone(id: string): RemovedConnection | undefined {
    const r = this.db.prepare('SELECT * FROM removed_connections WHERE id = ?').get(id) as Row | undefined;
    return r ? toTombstone(r) : undefined;
  }

  listTombstones(limit = 500): RemovedConnection[] {
    return (
      this.db
        .prepare('SELECT * FROM removed_connections ORDER BY removed_at DESC LIMIT ?')
        .all(Math.min(Math.max(limit, 1), 5000)) as Row[]
    ).map(toTombstone);
  }

  /**
   * The names of principal ids (journal, proposals, jobs and errors hold only the id): the live connection's label, else
   * its tombstone's with the day it was removed, else a plain "Removed connection". Never a bare id, never empty.
   */
  describePrincipals(ids: Iterable<string>): Map<string, PrincipalName> {
    const out = new Map<string, PrincipalName>();
    for (const id of new Set(ids)) {
      if (id === 'system') {
        out.set(id, { id, name: 'System', type: 'system', removedAt: null });
        continue;
      }
      // v3 F5b (ADR 0068): the automation engine's principal, and the owner's own governance writes on the Review page.
      if (id === 'automation') {
        out.set(id, { id, name: 'Automation', type: 'system', removedAt: null });
        continue;
      }
      if (id === 'owner') {
        out.set(id, { id, name: 'The owner (dashboard)', type: 'system', removedAt: null });
        continue;
      }
      const live = this.getConnection(id);
      if (live) {
        out.set(id, { id, name: live.label.slice(0, 120) || 'Connection', type: live.type, removedAt: null });
        continue;
      }
      const t = this.getTombstone(id);
      if (t) {
        out.set(id, {
          id,
          name: `${t.label.slice(0, 120) || 'Connection'} (removed ${formatDay(t.removedAt)})`,
          type: 'removed',
          removedAt: t.removedAt,
        });
        continue;
      }
      out.set(id, { id, name: 'Removed connection', type: 'removed', removedAt: null });
    }
    return out;
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

function toTombstone(r: Row): RemovedConnection {
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(r.id),
    type: r.type as 'grant' | 'pat',
    label: String(r.label),
    clientId: (r.client_id as string | null) ?? null,
    profileId: (r.profile_id as string | null) ?? null,
    profileLabel: (r.profile_label as string | null) ?? null,
    createdAt: Number(r.created_at),
    revokedAt: n(r.revoked_at),
    expiresAt: n(r.expires_at),
    removedAt: Number(r.removed_at),
    removedBy: r.removed_by as 'owner' | 'system',
  };
}

function maxOf(a: unknown, b: unknown): number | null {
  const xs = [a, b].filter((v) => v !== null && v !== undefined).map(Number);
  return xs.length ? Math.max(...xs) : null;
}
