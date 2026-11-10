/** Shared types of the project registry (v2 A1, docs/projects.md). */
import type { ProjectSettings } from './settings.js';

/**
 * The explicit "every project" scope for queries that are meant to span projects (dashboard overviews, pruning).
 * Every query that is not given it must be given one project id.
 */
export interface AllProjects {
  readonly allProjects: true;
}
export const ALL_PROJECTS: AllProjects = Object.freeze({ allProjects: true as const });

/** A query scope: one project's LegendKeeper id, or `ALL_PROJECTS`. */
export type ProjectScope = string | AllProjects;

export function isAllProjects(scope: ProjectScope): scope is AllProjects {
  return typeof scope === 'object' && scope !== null && scope.allProjects === true;
}

/** One row of `projects`. */
export interface ProjectRecord {
  /** The LegendKeeper project id. */
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
  readonly isDefault: boolean;
  readonly isSandbox: boolean;
  /** Per-project read-only: when true, it overrides the bridge-wide flag for this project. */
  readonly readOnly: boolean;
  readonly settings: ProjectSettings;
  /** Why the stored settings could not be read (they then read as empty), or null. */
  readonly settingsProblem: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly verifiedAt: number | null;
  /** OPS2: when the project was removed on the dashboard (it is then archived: history kept, read-only). */
  readonly archivedAt: number | null;
}

/**
 * Where a configured project stands this run.
 * - `verifying`: start-up has not finished checking its key yet;
 * - `active`: its key authenticated and belongs to the stored project; it is served;
 * - `unverified`: LegendKeeper could not be asked (unreachable, busy); checked again shortly; not served meanwhile;
 * - `stopped`: the key was refused, or it belongs to another project than the stored one; not served until fixed
 *   and restarted (or checked again from the dashboard). The other projects are unaffected.
 */
export type ProjectStatus = 'verifying' | 'active' | 'unverified' | 'stopped';

/** A project the bridge knows about this run: configured in the env file, stored in the database, or both. */
export interface ProjectView {
  readonly name: string;
  /** Null until a key has proved which LegendKeeper project it is. */
  readonly id: string | null;
  readonly displayName: string | null;
  readonly isDefault: boolean;
  readonly isSandbox: boolean;
  readonly readOnly: boolean;
  /** Listed in the env file (LK_PROJECTS, or the single-project form) with a key. */
  readonly configured: boolean;
  /** Stored in `projects` (it has, or had, data in this database). */
  readonly registered: boolean;
  /** `archived` (OPS2): removed on the dashboard; its history is kept and shown read-only. */
  readonly status: ProjectStatus | 'not_configured' | 'archived';
  /** Plain-language reason for any status but `active`. Never contains a key. */
  readonly reason: string | null;
  /** The env variable that holds the key (name only), when configured. */
  readonly keyVariable: string | null;
  /** Whether the key authenticated at the last check (null: not checked yet, or not configured). */
  readonly keyValid: boolean | null;
  readonly verifiedAt: number | null;
  readonly checkedAt: number | null;
  readonly settings: ProjectSettings;
  readonly settingsProblem: string | null;
  /** OPS2: where the key in use comes from: the encrypted store, the env file, or nowhere (no key). */
  readonly keySource: 'store' | 'env' | null;
  /** OPS2: the last four characters of the key in use (all that is ever shown of a key). */
  readonly keyHint: string | null;
  /** OPS2: the env file holds a different key than the store; the stored key is used. Names only. */
  readonly keyConflict: string | null;
  /** OPS2: paused and draining before removal: takes no new work; running work finishes. */
  readonly draining: boolean;
  readonly archivedAt: number | null;
}
