/**
 * The `project` argument of every MCP tool (v2 A1, docs/tools.md): a project name (any case) or a LegendKeeper project
 * id that maps back to a configured project.
 *
 * - Unknown: refused (`UNKNOWN_PROJECT`) with the list of configured names.
 * - Omitted on a READ tool: the default project.
 * - Omitted on a WRITE tool: refused (`PROJECT_REQUIRED`) while REQUIRE_PROJECT_FOR_WRITES is on (the default) and more
 *   than one project is configured, so a forgotten argument can never land in the wrong project; with one project,
 *   that project.
 * - A configured project whose key has never been verified has no id yet: refused (`PROJECT_UNAVAILABLE`).
 */
import type { ProjectView } from './types.js';

/** What the selector needs: `ProjectRegistry` and `StaticProjects` both provide it. */
export interface SelectableProjects {
  configuredNames(): string[];
  resolve(ref: string): ProjectView | undefined;
  byConfiguredName(name: string): ProjectView | undefined;
  defaultProject(): ProjectView;
}

export interface SelectedProject {
  /** The LegendKeeper project id. */
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
}

export interface ProjectSelectionError {
  readonly code: 'UNKNOWN_PROJECT' | 'PROJECT_REQUIRED' | 'PROJECT_UNAVAILABLE';
  readonly message: string;
  /** The configured project names an agent may pass. */
  readonly registered: readonly string[];
  readonly [key: string]: unknown;
}

export type ProjectSelection =
  | { readonly ok: true; readonly project: SelectedProject }
  | { readonly ok: false; readonly error: ProjectSelectionError };

export class ProjectSelector {
  constructor(
    readonly projects: SelectableProjects,
    /** REQUIRE_PROJECT_FOR_WRITES (default true). */
    readonly requireForWrites: boolean,
  ) {}

  select(ref: string | undefined, access: 'read' | 'write'): ProjectSelection {
    const registered = this.projects.configuredNames();
    const asked = ref?.trim();
    if (asked) {
      const found = this.projects.resolve(asked);
      if (found?.id) return { ok: true, project: picked(found) };
      const pending = this.projects.byConfiguredName(asked);
      if (pending) return { ok: false, error: unavailable(pending, registered) };
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_PROJECT',
          message: `There is no project "${asked.slice(0, 64)}" on this bridge. Use one of: ${registered.join(', ')}.`,
          registered,
        },
      };
    }
    if (access === 'write' && this.requireForWrites && registered.length > 1) {
      return {
        ok: false,
        error: {
          code: 'PROJECT_REQUIRED',
          message:
            `This bridge serves ${registered.length} projects (${registered.join(', ')}), so a write must name one: ` +
            'pass `project`. Nothing was sent.',
          registered,
        },
      };
    }
    const def = this.projects.defaultProject();
    if (!def.id) return { ok: false, error: unavailable(def, registered) };
    return { ok: true, project: picked(def) };
  }
}

function picked(p: ProjectView): SelectedProject {
  return { id: p.id!, name: p.name, isDefault: p.isDefault };
}

function unavailable(p: ProjectView, registered: readonly string[]): ProjectSelectionError {
  return {
    code: 'PROJECT_UNAVAILABLE',
    message: `Project "${p.name}" is not available: ${p.reason ?? 'its key has not been verified yet'}`,
    project: p.name,
    registered,
  };
}
