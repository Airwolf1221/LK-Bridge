/**
 * The policy layer's consent hooks (chunk 4's consent screen and PAT creation). The signed-in owner chooses the
 * profile a new connection acts under, and that profile's scope; the preselected scope is always `read`.
 * Only the redirect host (which the bridge verified) drives the suggestion; the client's self-reported name never does.
 */
import type { ConsentProfileChoice, ConsentProfiles, ProfileOption } from '../auth/services.js';
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

export function createConsentProfiles(store: PolicyStore): ConsentProfiles {
  return {
    kinds: PROFILE_KINDS,
    scopes: SCOPES,
    options: (): ProfileOption[] =>
      store.listProfiles().map((p) => ({ id: p.id, label: p.label, kind: p.kind, scope: p.scope })),
    suggest: (redirectUri) => {
      const kind = suggestKind(redirectUri);
      return { kind, label: kind };
    },
    apply: (choice: ConsentProfileChoice) => {
      if (!isScope(choice.scope)) return { ok: false, error: 'Choose read, propose or write.' };
      const scope: Scope = choice.scope;
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
