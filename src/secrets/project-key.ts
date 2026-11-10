/**
 * Which key a project uses, decided the way the running bridge decides it (ADR 0028 decisions 2 and 5; the
 * registry's `adoptStoredKey` in src/projects/registry.ts), for the tools that run beside the bridge: the sandbox, soak,
 * spike and round-trip scripts.
 *
 * 1. A key stored in the encrypted store for the project's LegendKeeper id wins, whatever the env file says.
 * 2. Only when nothing is stored for the project is the env file's key used (`LK_PROJECT_<NAME>_API_KEY`, or the
 *    single-project form's `LK_API_KEY`): a database from before OPS2, or a key the bridge has not imported yet.
 * 3. A stored key that cannot be opened (no master key, the wrong one, a damaged row) is refused, and the env file's key
 *    is NOT used instead: it may be the old key the dashboard replaced.
 *
 * The store is read through `SecretStore` (no other code decrypts anything). Results and messages carry names only,
 * never a value.
 */
import type { Db } from '../db/open.js';
import { SecretStore, type SecretKeys } from './store.js';

export type ProjectKeySource = 'store' | 'env';

export type ProjectKeyResult =
  | { readonly ok: true; readonly apiKey: string; readonly source: ProjectKeySource }
  /** `missing`: no key in the store and none in the env file. `unreadable`: stored but cannot be opened here. */
  | { readonly ok: false; readonly reason: 'missing' | 'unreadable'; readonly detail: string | null };

export function resolveProjectKey(
  db: Db,
  projectId: string,
  o: SecretKeys & {
    /** The env file's key for the project, if any (the value of its key variable). */
    readonly envKey?: string | undefined;
  },
): ProjectKeyResult {
  if (hasTable(db, 'secrets')) {
    const stored = new SecretStore(db, o).read(projectId, 'lk_api_key');
    if (stored.ok) return { ok: true, apiKey: stored.value, source: 'store' };
    if (stored.reason !== 'not_stored') return { ok: false, reason: 'unreadable', detail: stored.message };
  }
  const envKey = o.envKey?.trim();
  if (envKey) return { ok: true, apiKey: envKey, source: 'env' };
  return { ok: false, reason: 'missing', detail: null };
}

function hasTable(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
