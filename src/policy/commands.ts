/**
 * The owner command layer: plain functions for chunk 5's dashboard routes to call after it has authenticated the
 * owner (session cookie + CSRF). Every function takes `actor: 'owner'` first, every change writes an `audit_log` row
 * and emits a `policy` event, and NONE of this is reachable from MCP: no MCP tool imports this module
 * (test/policy/no-agent-escalation.test.ts enumerates every registered tool and checks).
 */
import type { AuthStore } from '../auth/store.js';
import { PolicyError } from './errors.js';
import type { ProposalDetail, ProposalService } from './proposals.js';
import type { AuditRow, ConnectionView, PolicyStore } from './store.js';
import {
  isProfileKind,
  isScope,
  type OwnerActor,
  type Profile,
  type ProfileKind,
  type ProposalFilter,
  type ProposalView,
  type Scope,
} from './types.js';

export interface ProfileSummary extends Profile {
  /** Active grants and PATs using the profile. */
  readonly connections: number;
}

export interface BulkResult {
  readonly id: string;
  readonly ok: boolean;
  readonly state?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface OwnerCommands {
  listProfiles(actor: OwnerActor): ProfileSummary[];
  createProfile(
    actor: OwnerActor,
    input: { readonly label: string; readonly kind: ProfileKind; readonly scope?: Scope },
  ): Profile;
  setScope(actor: OwnerActor, profileId: string, scope: Scope): Profile;
  /** v2 B2: shows or hides the low-level tools for a profile's connections. Audited as `profile.set_low_level_tools`. */
  setShowLowLevelTools(actor: OwnerActor, profileId: string, show: boolean): Profile;
  getDefaultScope(actor: OwnerActor): Scope;
  setDefaultScope(actor: OwnerActor, scope: Scope): Scope;
  listGrantsAndPats(actor: OwnerActor): ConnectionView[];
  /** Moves a grant or PAT to another profile (for example out of `legacy`). */
  setConnectionProfile(actor: OwnerActor, connectionId: string, profileId: string): ConnectionView;
  /** Revokes a grant (`grant_…`: its refresh and access tokens) or a PAT (`pat_…`). */
  revoke(actor: OwnerActor, connectionId: string): boolean;
  /** v2 A1: `filter.project` is one project's id or `ALL_PROJECTS`. */
  listProposals(actor: OwnerActor, filter: ProposalFilter): ProposalView[];
  getProposal(actor: OwnerActor, id: string): ProposalDetail;
  approve(actor: OwnerActor, id: string): Promise<ProposalView>;
  reject(actor: OwnerActor, id: string, reason?: string): ProposalView;
  bulkApprove(actor: OwnerActor, ids: readonly string[]): Promise<BulkResult[]>;
  bulkReject(actor: OwnerActor, ids: readonly string[], reason?: string): BulkResult[];
  listAudit(actor: OwnerActor, filter?: { limit?: number; before?: number; action?: string }): AuditRow[];
}

export interface OwnerCommandDeps {
  readonly store: PolicyStore;
  readonly proposals: ProposalService;
  readonly authStore: AuthStore;
}

function assertOwner(actor: unknown): asserts actor is OwnerActor {
  if (actor !== 'owner') throw new PolicyError('NOT_OWNER', 'Only the owner can do this');
}

const errorOf = (e: unknown) =>
  e instanceof PolicyError
    ? { code: e.code, message: e.message }
    : { code: 'ERROR', message: e instanceof Error ? e.message : String(e) };

export function createOwnerCommands(d: OwnerCommandDeps): OwnerCommands {
  const { store, proposals } = d;
  const nowSec = () => Math.floor(store.now() / 1000);

  const connection = (id: string): ConnectionView => {
    const c = store.listConnections().find((x) => x.id === id);
    if (!c) throw new PolicyError('CONNECTION_NOT_FOUND', `No grant or personal access token ${id}`);
    return c;
  };

  const commands: OwnerCommands = {
    listProfiles(actor) {
      assertOwner(actor);
      const counts = new Map<string, number>();
      for (const c of store.listConnections()) {
        if (c.active && c.profileId) counts.set(c.profileId, (counts.get(c.profileId) ?? 0) + 1);
      }
      return store.listProfiles().map((p) => ({ ...p, connections: counts.get(p.id) ?? 0 }));
    },

    createProfile(actor, input) {
      assertOwner(actor);
      if (!isProfileKind(input.kind))
        throw new PolicyError('INVALID_INPUT', `Unknown profile kind: ${String(input.kind)}`);
      if (input.scope !== undefined && !isScope(input.scope)) {
        throw new PolicyError('INVALID_INPUT', `Unknown scope: ${String(input.scope)}`);
      }
      const p = store.insertProfile(input);
      store.audit('owner', 'profile.create', p.id, undefined, p);
      return p;
    },

    setScope(actor, profileId, scope) {
      assertOwner(actor);
      const { before, after } = store.updateScope(profileId, scope);
      store.audit('owner', 'profile.set_scope', profileId, { scope: before.scope }, { scope: after.scope });
      return after;
    },

    setShowLowLevelTools(actor, profileId, show) {
      assertOwner(actor);
      if (typeof show !== 'boolean')
        throw new PolicyError('INVALID_INPUT', 'showLowLevelTools is true or false');
      const { before, after } = store.updateShowLowLevelTools(profileId, show);
      store.audit(
        'owner',
        'profile.set_low_level_tools',
        profileId,
        { showLowLevelTools: before.showLowLevelTools },
        { showLowLevelTools: after.showLowLevelTools },
      );
      return after;
    },

    getDefaultScope(actor) {
      assertOwner(actor);
      return store.defaultScope();
    },

    setDefaultScope(actor, scope) {
      assertOwner(actor);
      const before = store.defaultScope();
      store.writeDefaultScope(scope, 'owner');
      store.audit('owner', 'policy.set_default_scope', 'default_scope', { scope: before }, { scope });
      return scope;
    },

    listGrantsAndPats(actor) {
      assertOwner(actor);
      return store.listConnections();
    },

    setConnectionProfile(actor, connectionId, profileId) {
      assertOwner(actor);
      const before = connection(connectionId);
      const profile = store.getProfile(profileId);
      if (!profile) throw new PolicyError('PROFILE_NOT_FOUND', `No profile ${profileId}`);
      const table = before.type === 'grant' ? 'auth_token_families' : 'auth_pats';
      const key = before.type === 'grant' ? 'family_id' : 'id';
      store.db.prepare(`UPDATE ${table} SET profile_id = ? WHERE ${key} = ?`).run(profileId, connectionId);
      store.bump();
      store.audit(
        'owner',
        'connection.set_profile',
        connectionId,
        { profileId: before.profileId },
        { profileId },
      );
      return connection(connectionId);
    },

    revoke(actor, connectionId) {
      assertOwner(actor);
      const before = connection(connectionId);
      const done =
        before.type === 'grant'
          ? d.authStore.revokeFamily(connectionId, 'revoked_by_owner', nowSec())
          : d.authStore.revokePat(connectionId, nowSec());
      store.bump();
      if (done)
        store.audit('owner', 'connection.revoke', connectionId, { active: before.active }, { active: false });
      return done;
    },

    listProposals(actor, filter) {
      assertOwner(actor);
      return proposals.list(filter);
    },

    getProposal(actor, id) {
      assertOwner(actor);
      const p = proposals.detail(id);
      if (!p) throw new PolicyError('PROPOSAL_NOT_FOUND', `No proposal ${id}`);
      return p;
    },

    approve(actor, id) {
      assertOwner(actor);
      return proposals.approve(actor, id);
    },

    reject(actor, id, reason) {
      assertOwner(actor);
      return proposals.reject(actor, id, reason);
    },

    async bulkApprove(actor, ids) {
      assertOwner(actor);
      const out: BulkResult[] = [];
      // One at a time, in order: each approval re-reads its targets, and an earlier one may change a later one's.
      for (const id of new Set(ids)) {
        try {
          const p = await proposals.approve(actor, id);
          out.push({ id, ok: p.state === 'executing' || p.state === 'executed', state: p.state });
        } catch (e) {
          out.push({ id, ok: false, state: proposals.state(id) ?? 'unknown', error: errorOf(e) });
        }
      }
      return out;
    },

    bulkReject(actor, ids, reason) {
      assertOwner(actor);
      const out: BulkResult[] = [];
      for (const id of new Set(ids)) {
        try {
          out.push({ id, ok: true, state: proposals.reject(actor, id, reason).state });
        } catch (e) {
          out.push({ id, ok: false, state: proposals.state(id) ?? 'unknown', error: errorOf(e) });
        }
      }
      return out;
    },

    listAudit(actor, filter = {}) {
      assertOwner(actor);
      return store.listAudit(filter);
    },
  };
  return Object.freeze(commands);
}
