import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { api, type ApiError } from './api';
import { useApi, useReloadOn, type Resource } from './hooks';
import { useStreamEvent } from './stream';
import type { BudgetPayload, BudgetStreamPayload, ProjectInfo, ProjectsResponse } from './types';

/**
 * The project the dashboard is looking at (v2 A1). The bridge serves several LegendKeeper projects; the pages that show
 * one project's data (Overview, Jobs, Errors, Budgets, Journal, Proposals, Mappings) ask for the selected one with a
 * `project=<name>` query parameter. The choice is kept per browser (`lkb-project`); without one, the bridge's default
 * project is shown. Live events that name another project are ignored by those pages.
 */

export const PROJECT_STORAGE_KEY = 'lkb-project';

const readStored = (): string | null => {
  try {
    return window.localStorage.getItem(PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
};

const writeStored = (name: string): void => {
  try {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, name);
  } catch {
    // Storage may be blocked: the choice just does not persist.
  }
};

/** Appends `project=<name>` to an admin API path, keeping its query. A path that already names a project is kept. */
export function pathWithProject(path: string, name: string | null | undefined): string {
  if (!name) return path;
  const q = path.indexOf('?');
  if (q >= 0 && new URLSearchParams(path.slice(q + 1)).has('project')) return path;
  return `${path}${q >= 0 ? '&' : '?'}project=${encodeURIComponent(name)}`;
}

/** The LegendKeeper project id an event names (`projectId`, or a job's), if any. */
export function eventProjectId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as { projectId?: unknown; job?: { projectId?: unknown } | null };
  if (typeof d.projectId === 'string') return d.projectId;
  if (d.job && typeof d.job.projectId === 'string') return d.job.projectId;
  return undefined;
}

export interface ProjectApi {
  /** `GET /projects`, as last loaded (undefined until then, or when it failed). */
  data: ProjectsResponse | undefined;
  error: ApiError | undefined;
  /** Every project the bridge knows (empty until the list has loaded). */
  projects: ProjectInfo[];
  /** True once the list has loaded, or failed (the bridge's default project is then used): pages may load. */
  ready: boolean;
  defaultName: string | null;
  /** The selected project's name (null only when the list could not be loaded). */
  selected: string | null;
  /** Its LegendKeeper id (null until a key has proved it, or when unknown). */
  selectedId: string | null;
  current: ProjectInfo | null;
  select: (name: string) => void;
  reload: () => void;
  /** Appends `project=` (the selected project, or `name`) to an admin API path. */
  withProject: (path: string, name?: string | null) => string;
  /** A project's name from its LegendKeeper id (null when unknown). */
  nameOf: (id: string | null | undefined) => string | null;
  /** Whether an event naming `projectId` concerns the selected project. Events that name no project always do. */
  isSelected: (projectId: string | null | undefined) => boolean;
}

const ProjectContext = createContext<ProjectApi | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const list = useApi<ProjectsResponse>('/projects');
  // A project's status or flags changed (verified, stopped, read-only): reload the list.
  useReloadOn(['project'], list.reload, 300);
  const [choice, setChoice] = useState<string | null>(readStored);
  const select = useCallback((name: string) => {
    setChoice(name);
    writeStored(name);
  }, []);

  const { data, error, reload } = list;
  const value = useMemo<ProjectApi>(() => {
    const projects = data?.projects ?? [];
    const defaultName = data?.default ?? null;
    // A stored choice the bridge no longer knows falls back to the default project.
    const selected = data ? (choice && projects.some((p) => p.name === choice) ? choice : defaultName) : null;
    const current = projects.find((p) => p.name === selected) ?? null;
    const selectedId = current?.id ?? null;
    return {
      data,
      error,
      projects,
      ready: data !== undefined || error !== undefined,
      defaultName,
      selected,
      selectedId,
      current,
      select,
      reload,
      withProject: (path, name = selected) => pathWithProject(path, name),
      nameOf: (id) => (id ? (projects.find((p) => p.id === id)?.name ?? null) : null),
      isSelected: (projectId) => !projectId || !selectedId || projectId === selectedId,
    };
  }, [data, error, choice, select, reload]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectApi {
  const p = useContext(ProjectContext);
  if (!p) throw new Error('useProject needs a <ProjectProvider>');
  return p;
}

/** `useApi` for a project-scoped route: the path carries the selected project, and nothing loads before it is known. */
export function useScopedApi<T>(path: string | null, project?: string | null): Resource<T> {
  const { ready, withProject } = useProject();
  return useApi<T>(path === null || !ready ? null : withProject(path, project));
}

/** The admin API with every request in the selected project (`project=` added to each path). */
export function useProjectApi(): typeof api {
  const { withProject } = useProject();
  return useMemo(
    () => ({
      get: <T,>(path: string) => api.get<T>(withProject(path)),
      post: <T,>(path: string, body?: unknown) => api.post<T>(withProject(path), body),
      put: <T,>(path: string, body?: unknown) => api.put<T>(withProject(path), body),
      upload: <T,>(path: string, file: Blob) => api.upload<T>(withProject(path), file),
    }),
    [withProject],
  );
}

/** `useReloadOn`, ignoring events that name another project than the selected one. */
export function useProjectReloadOn(events: readonly string[], reload: () => void, ms = 250): void {
  const { isSelected } = useProject();
  useReloadOn(events, reload, ms, (data) => isSelected(eventProjectId(data)));
}

/** The latest `budget` event: every project's live budget, by LegendKeeper id (null until one arrives). */
export function useLiveBudgets(): BudgetStreamPayload['projects'] | null {
  const [live, setLive] = useState<BudgetStreamPayload['projects'] | null>(null);
  useStreamEvent<BudgetStreamPayload | null>('budget', (d) => setLive(d?.projects ?? null));
  return live;
}

/** The selected project's live budget (null until a `budget` event carries it). */
export function useLiveBudget(): BudgetPayload | null {
  const all = useLiveBudgets();
  const { selectedId } = useProject();
  return (selectedId && all?.[selectedId]) || null;
}
