/**
 * `factsVersion` (v2 C2b, ADR 0034): the bridge's own version of a page's sidebar facts. LegendKeeper gives no version
 * that covers a whole sidebar (`listProperties`, `getProperty` and `listPropertyRows` carry none that does; checked on
 * 10 November 2026), so nothing caught a change made after an agent last read a page and before it called set_facts.
 *
 * - `factsVersionFrom(body)`: the version and the normalised state of a `listProperties` or `getResource` answer: the
 *   key-value rows in rank order by id (C2a.1) and the link collections (items and filter), properties by id, so every
 *   endpoint gives the same version for the same sidebar (src/jobs/sidebar-state.ts).
 * - `FactsVersions`: the state at each version the bridge handed out (get_resource, get_resources, set_facts, the create
 *   tools), five per page for seven days, so a stale `baseFactsVersion` is answered with WHICH rows or collections
 *   changed. A cache: a version it does not remember is still a conflict, only without the list.
 */
import type { Db } from '../db/open.js';
import {
  compareSidebarStates,
  factsVersionOf,
  sidebarState,
  type SidebarPropertyState,
  type StateDifference,
} from '../jobs/sidebar-state.js';

export interface FactsVersionSettings {
  readonly perPage: number;
  readonly maxAgeMs: number;
  readonly maxBytes: number;
}

export const DEFAULT_FACTS_VERSION_SETTINGS: FactsVersionSettings = Object.freeze({
  perPage: 5,
  maxAgeMs: 7 * 24 * 3_600_000,
  maxBytes: 512 * 1024,
});

/** The facts version and normalised state of a sidebar read (`listProperties` or `getResource`). */
export function factsVersionFrom(body: unknown): {
  readonly version: string;
  readonly state: SidebarPropertyState[];
} {
  const state = sidebarState(body);
  return { version: factsVersionOf(state), state };
}

/** Which rows or collections differ between a remembered state and the current one (as conflict details). */
export function factsDifferences(
  base: readonly SidebarPropertyState[],
  current: readonly SidebarPropertyState[],
): StateDifference[] {
  return compareSidebarStates(base, current);
}

export class FactsVersions {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly settings: FactsVersionSettings = DEFAULT_FACTS_VERSION_SETTINGS,
  ) {}

  /** Remembers the state of a sidebar read and returns its version. */
  remember(projectId: string, resourceId: string, body: unknown): string {
    const { version, state } = factsVersionFrom(body);
    this.store(projectId, resourceId, version, state);
    return version;
  }

  store(
    projectId: string,
    resourceId: string,
    version: string,
    state: readonly SidebarPropertyState[],
  ): void {
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text, 'utf8') > this.settings.maxBytes) return;
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO facts_versions (project_id, resource_id, version, state, stored_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, resource_id, version) DO UPDATE SET stored_at = excluded.stored_at`,
      )
      .run(projectId, resourceId, version, text, at);
    this.db
      .prepare(
        `DELETE FROM facts_versions WHERE project_id = ? AND resource_id = ? AND version NOT IN (
           SELECT version FROM facts_versions WHERE project_id = ? AND resource_id = ?
            ORDER BY stored_at DESC LIMIT ?)`,
      )
      .run(projectId, resourceId, projectId, resourceId, this.settings.perPage);
    this.db.prepare('DELETE FROM facts_versions WHERE stored_at < ?').run(at - this.settings.maxAgeMs);
  }

  /** The state at `version`, or null when it is not remembered. */
  recall(projectId: string, resourceId: string, version: string): SidebarPropertyState[] | null {
    const r = this.db
      .prepare(
        'SELECT state, stored_at FROM facts_versions WHERE project_id = ? AND resource_id = ? AND version = ?',
      )
      .get(projectId, resourceId, version) as { state: string; stored_at: number } | undefined;
    if (!r || this.now() - r.stored_at > this.settings.maxAgeMs) return null;
    try {
      const v = JSON.parse(r.state) as unknown;
      return Array.isArray(v) ? (v as SidebarPropertyState[]) : null;
    } catch {
      return null;
    }
  }
}
