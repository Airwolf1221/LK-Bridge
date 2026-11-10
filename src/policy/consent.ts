/**
 * The policy layer's consent hooks (chunk 4's consent screen and PAT creation). The signed-in owner chooses the
 * profile a new connection acts under, and that profile's scope. The page preselects an existing profile's CURRENT scope
 * (so approving untouched changes nothing) and the configured default scope for a new profile; a change to an existing
 * profile's scope is applied only after the owner confirms it on a second page (v1.0.1, F-15).
 * Only the redirect host (which the bridge verified) drives the suggestion; the client's self-reported name never does.
 */
import {
  KEEP_SCOPE,
  type ConsentApplyResult,
  type ConsentProfileChoice,
  type ConsentProfiles,
  type ProfileOption,
} from '../auth/services.js';
import type { ConnectionManager } from './connections.js';
import { PolicyError } from './errors.js';
import type { PolicyStore } from './store.js';
import { PROFILE_KINDS, SCOPES, isProfileKind, isScope, type ProfileKind, type Scope } from './types.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** claude.ai and claude.com → `claude`; chatgpt.com → `chatgpt`; loopback → `claude-code`; anything else → `other`. */
export function suggestKind(redirectUri: string): ProfileKind {
  let host: string;
  try {
    host = new URL(redirectUri).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host === 'claude.ai' || host === 'claude.com') return 'claude';
  if (host === 'chatgpt.com') return 'chatgpt';
  if (LOOPBACK_HOSTS.has(host)) return 'claude-code';
  return 'other';
}

/** Gets (or creates, at the default scope unless `scope` is given) the profile with this label. Audited. */
export function ensureProfile(
  store: PolicyStore,
  label: string,
  kind: ProfileKind,
  scope?: Scope,
  actor = 'owner',
): { id: string; created: boolean } {
  const existing = store.getProfileByLabel(label);
  if (existing) return { id: existing.id, created: false };
  const p = store.insertProfile({ label, kind, ...(scope !== undefined ? { scope } : {}) });
  store.audit(actor, 'profile.create', p.id, undefined, p);
  return { id: p.id, created: true };
}

/** The default label (and kind) of a PAT's profile: Claude Code's. */
export const DEFAULT_PAT_PROFILE = 'claude-code';

/** Active connections (grants and PATs) per profile id. */
function connectionCounts(store: PolicyStore): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of store.listConnections()) {
    if (c.active && c.profileId) counts.set(c.profileId, (counts.get(c.profileId) ?? 0) + 1);
  }
  return counts;
}

/** The confirmation token for one exact change: profile, current scope and new scope. */
export function scopeChangeToken(profileId: string, from: Scope, to: Scope): string {
  return `${profileId}:${from}:${to}`;
}

export function createConsentProfiles(store: PolicyStore, connections?: ConnectionManager): ConsentProfiles {
  return {
    kinds: PROFILE_KINDS,
    scopes: SCOPES,
    options: (): ProfileOption[] => {
      const counts = connectionCounts(store);
      return store.listProfiles().map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        scope: p.scope,
        connections: counts.get(p.id) ?? 0,
      }));
    },
    defaultScope: () => store.defaultScope(),
    suggest: (redirectUri) => {
      const kind = suggestKind(redirectUri);
      return { kind, label: kind };
    },
    existingConnections: (app) => connections?.existing(app) ?? [],
    replaceConnections: (r) => connections?.replace(r) ?? [],
    apply: (choice: ConsentProfileChoice): ConsentApplyResult => {
      // `keep` (hotfix, ADR 0033): the chosen existing profile's current scope, or the default scope for a new profile.
      // It never differs from the profile's scope, so it never asks for the scope-change confirmation.
      let chosen: string = choice.scope;
      if (chosen === KEEP_SCOPE) {
        const current = choice.profileId === 'new' ? undefined : store.getProfile(choice.profileId);
        if (choice.profileId !== 'new' && !current)
          return { ok: false, error: 'That profile no longer exists. Start again from the application.' };
        chosen = current ? current.scope : store.defaultScope();
      }
      if (!isScope(chosen)) return { ok: false, error: 'Choose read, propose or write.' };
      const scope: Scope = chosen;
      try {
        if (choice.profileId === 'new') {
          if (!isProfileKind(choice.newKind))
            return { ok: false, error: 'Choose a kind for the new profile.' };
          const label = (choice.newLabel ?? '').trim();
          if (store.getProfileByLabel(label)) {
            return {
              ok: false,
              error: `A profile labelled "${label}" already exists. Choose it from the list instead.`,
            };
          }
          const p = store.insertProfile({ label, kind: choice.newKind, scope });
          store.audit('owner', 'profile.create', p.id, undefined, { ...p, via: 'consent' });
          return { ok: true, profileId: p.id };
        }
        const p = store.getProfile(choice.profileId);
        if (!p)
          return { ok: false, error: 'That profile no longer exists. Start again from the application.' };
        if (p.scope !== scope) {
          // Never change an existing profile's scope without an explicit, confirmed choice for exactly this change.
          // The token names the scope the profile has NOW, so a profile changed elsewhere meanwhile asks again.
          const token = scopeChangeToken(p.id, p.scope, scope);
          if (choice.confirmScopeChange !== token) {
            return {
              ok: false,
              confirm: {
                profileId: p.id,
                label: p.label,
                from: p.scope,
                to: scope,
                connections: connectionCounts(store).get(p.id) ?? 0,
                token,
              },
            };
          }
          store.updateScope(p.id, scope);
          store.audit('owner', 'profile.set_scope', p.id, { scope: p.scope }, { scope, via: 'consent' });
        }
        return { ok: true, profileId: p.id };
      } catch (e) {
        if (e instanceof PolicyError) return { ok: false, error: e.message };
        throw e;
      }
    },
    defaultPatProfileId: () => ensureProfile(store, DEFAULT_PAT_PROFILE, 'claude-code').id,
  };
}
