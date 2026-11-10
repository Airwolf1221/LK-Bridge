/**
 * Connection lifecycle beyond create and revoke (hotfix, ADR 0033): removing revoked and expired connections (with a
 * tombstone, so history can still name them), the automatic daily removal, "stale" connections, and replacing the old
 * connections of an application when it reconnects.
 *
 * Everything here runs on the bridge's one SQLite database; a removal is a single transaction across the auth tables, the
 * tombstone and the audit row. The owner commands (commands.ts) and the maintenance sweep call it; no MCP tool does.
 */
import { sameApplication, type ApplicationRef } from '../auth/application.js';
import type { ExistingConnection } from '../auth/services.js';
import type { AuthStore } from '../auth/store.js';
import { PolicyError } from './errors.js';
import type { ConnectionView, PolicyStore, RemovedConnection } from './store.js';

const DAY_MS = 86_400_000;

/** The audit `via` of a revocation: who or what caused it. The owner's own Revoke button keeps its v1 audit shape. */
export type RevokeVia = 'owner' | 'replaced' | 'stale';

export interface ConnectionManager {
  /** Every revoked or expired connection (what "Remove all revoked and expired" would remove), newest first. */
  inactive(): ConnectionView[];
  /** Removes one revoked or expired connection. An active one is refused: `CONNECTION_ACTIVE`. */
  remove(id: string, by: 'owner' | 'system'): RemovedConnection;
  /** Removes every revoked or expired connection, in one transaction. */
  removeInactive(by: 'owner' | 'system'): { removed: number; ids: string[] };
  /**
   * The daily sweep: removes the revoked or expired connections whose dead time (`revoked_at`, or `expires_at` when
   * it expired without being revoked) is at least `connections.auto_remove_days` days ago. 0 = never.
   */
  sweepInactive(): { removed: number; ids: string[] };
  /** Active connections of one profile that are stale (unused for `connections.stale_after_days`). */
  staleOf(profileId: string): ConnectionView[];
  /** Revokes the stale connections of one profile (audited `connection.revoke`, `via: 'stale'`). */
  revokeStale(profileId: string): string[];
  /** The active grants of the same application as `app`, for the consent page. */
  existing(app: ApplicationRef): ExistingConnection[];
  /** Revokes the grants a just-exchanged code replaces (see `ConsentProfiles.replaceConnections`). */
  replace(r: {
    newFamilyId: string;
    app: ApplicationRef;
    replaces: readonly string[];
    now: number;
  }): string[];
}

/** When a dead (revoked or expired) connection died: its `revoked_at`, else its `expires_at`. */
function deadAt(c: ConnectionView): number | null {
  return c.revokedAt ?? c.expiresAt;
}

export function createConnectionManager(d: {
  readonly store: PolicyStore;
  readonly authStore: AuthStore;
}): ConnectionManager {
  const { store, authStore } = d;

  const inactive = () => store.listConnections().filter((c) => !c.active);

  /** The tombstone fields, which are also the audit row's `before`. */
  const tombstoneOf = (c: ConnectionView, by: 'owner' | 'system'): RemovedConnection => ({
    id: c.id,
    type: c.type,
    label: c.label,
    clientId: c.clientId,
    profileId: c.profileId,
    profileLabel: c.profile,
    createdAt: c.createdAt,
    revokedAt: c.revokedAt,
    expiresAt: c.expiresAt,
    removedAt: store.now(),
    removedBy: by,
  });

  const removeOne = (id: string, by: 'owner' | 'system'): RemovedConnection =>
    // One transaction: the tombstone, the credentials and the audit row all happen, or none of them does.
    store.tx(() => {
      const c = store.getConnection(id);
      if (!c) throw new PolicyError('CONNECTION_NOT_FOUND', `No grant or personal access token ${id}`);
      if (c.active) {
        throw new PolicyError(
          'CONNECTION_ACTIVE',
          `${c.label} is still active. Revoke it first; only a revoked or expired connection can be removed.`,
        );
      }
      const tombstone = tombstoneOf(c, by);
      store.insertTombstone(tombstone);
      if (c.type === 'grant') authStore.deleteGrantCredentials(id);
      else authStore.deletePat(id);
      store.audit(by, 'connection.remove', id, tombstone, null);
      return tombstone;
    });

  const removeMany = (list: readonly ConnectionView[], by: 'owner' | 'system') => {
    if (list.length === 0) return { removed: 0, ids: [] as string[] };
    const ids = store.tx(() => list.map((c) => removeOne(c.id, by).id));
    store.bump();
    return { removed: ids.length, ids };
  };

  const revokeOne = (
    c: ConnectionView,
    reason: string,
    via: RevokeVia,
    extra: Record<string, unknown> = {},
  ) => {
    const nowSec = Math.floor(store.now() / 1000);
    const done =
      c.type === 'grant' ? authStore.revokeFamily(c.id, reason, nowSec) : authStore.revokePat(c.id, nowSec);
    if (done) {
      store.audit('owner', 'connection.revoke', c.id, { active: c.active }, { active: false, via, ...extra });
    }
    return done;
  };

  return {
    inactive,

    remove(id, by) {
      const t = removeOne(id, by);
      store.bump();
      return t;
    },

    removeInactive: (by) => removeMany(inactive(), by),

    sweepInactive() {
      const days = store.autoRemoveDays();
      if (days <= 0) return { removed: 0, ids: [] };
      const cutoff = store.now() - days * DAY_MS;
      return removeMany(
        inactive().filter((c) => {
          const at = deadAt(c);
          return at !== null && at <= cutoff;
        }),
        'system',
      );
    },

    staleOf: (profileId) => store.listConnections().filter((c) => c.stale && c.profileId === profileId),

    revokeStale(profileId) {
      const stale = store.listConnections().filter((c) => c.stale && c.profileId === profileId);
      const revoked = store.tx(() =>
        stale.filter((c) => revokeOne(c, 'revoked_stale', 'stale')).map((c) => c.id),
      );
      store.bump();
      return revoked;
    },

    existing(app) {
      const clients = new Map(authStore.listClients().map((c) => [c.clientId, c]));
      return store
        .listConnections()
        .filter((c) => {
          if (c.type !== 'grant' || !c.active || c.clientId === null) return false;
          const client = clients.get(c.clientId);
          return client !== undefined && sameApplication(app, client);
        })
        .map((c) => ({
          id: c.id,
          label: c.label,
          type: c.type,
          profile: c.profile,
          createdAt: c.createdAt,
          lastUsedAt: c.lastUsedAt,
        }));
    },

    replace({ newFamilyId, app, replaces, now }) {
      const revoked: string[] = [];
      for (const id of new Set(replaces)) {
        // Re-checked now, not at approval: the grant must still be active, and still be of the same application.
        if (id === newFamilyId || !id.startsWith('grant_')) continue;
        const family = authStore.getFamily(id);
        if (!family || family.revokedAt !== null || family.expiresAt <= now) continue;
        const client = authStore.getClient(family.clientId);
        if (!client || !sameApplication(app, client)) continue;
        if (authStore.revokeFamily(id, `replaced by ${newFamilyId}`, now)) {
          store.audit(
            'owner',
            'connection.revoke',
            id,
            { active: true },
            { active: false, via: 'replaced', replacedBy: newFamilyId },
          );
          revoked.push(id);
        }
      }
      if (revoked.length > 0) store.bump();
      return revoked;
    },
  };
}
