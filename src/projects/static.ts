/**
 * A fixed set of projects that are all served at once, without start-up checks: for tests and for tools that build an
 * engine around clients they already trust (the sandbox scripts check their own key before anything else). Each
 * client's `projectId` is its project's LegendKeeper id; each is registered in `projects` (name and flags as given).
 */
import type { Db } from '../db/open.js';
import type { LkClient } from '../lk/client.js';
import type { ProjectsRuntime } from './registry.js';
import type { SelectableProjects } from './selection.js';
import { ProjectStore } from './store.js';
import type { ProjectView } from './types.js';

export interface StaticProject {
  readonly client: LkClient;
  readonly name: string;
  readonly readOnly?: boolean;
  readonly isSandbox?: boolean;
  readonly isDefault?: boolean;
}

export class StaticProjects implements ProjectsRuntime, SelectableProjects {
  readonly store: ProjectStore;
  private readonly byId = new Map<string, StaticProject & { unavailable?: string | undefined }>();
  private readonly listeners = new Set<(v: ProjectView) => void>();

  constructor(db: Db, projects: readonly StaticProject[], now: () => number = Date.now) {
    this.store = new ProjectStore(db, now);
    projects.forEach((p, i) => {
      const id = p.client.projectId;
      const stored = this.store.byId(id);
      if (!stored) this.store.insert({ id, name: p.name, displayName: null, verifiedAt: null });
      if (p.readOnly !== undefined) this.store.setReadOnly(id, p.readOnly);
      if (p.isSandbox !== undefined) this.store.setSandbox(id, p.isSandbox);
      if (p.isDefault ?? i === 0) this.store.setDefault(p.name);
      this.byId.set(id, p);
    });
  }

  client(projectId: string): LkClient | undefined {
    const p = this.byId.get(projectId);
    return p && !p.unavailable ? p.client : undefined;
  }
  anyClient(projectId: string): LkClient | undefined {
    return this.byId.get(projectId)?.client;
  }
  known(projectId: string): boolean {
    return this.store.byId(projectId) !== undefined;
  }
  nameOf(projectId: string): string {
    return this.store.byId(projectId)?.name ?? projectId;
  }
  readOnly(projectId: string): boolean {
    return this.store.byId(projectId)?.readOnly === true;
  }
  unavailableReason(projectId: string): string | null {
    const p = this.byId.get(projectId);
    if (!p) return `there is no project with id ${projectId}`;
    return p.unavailable ?? null;
  }
  activeIds(): string[] {
    return [...this.byId.entries()].filter(([, p]) => !p.unavailable).map(([id]) => id);
  }
  onChange(cb: (v: ProjectView) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ------------------------------------------------------------------------- SelectableProjects (the tools)

  configuredNames(): string[] {
    return [...this.byId.values()].map((p) => p.name);
  }
  resolve(ref: string): ProjectView | undefined {
    const r = ref.trim();
    for (const [id, p] of this.byId) if (p.name === r.toLowerCase() || id === r) return this.view(id);
    return undefined;
  }
  byConfiguredName(name: string): ProjectView | undefined {
    return this.resolve(name);
  }
  defaultProject(): ProjectView {
    const rec = this.store.list().find((r) => r.isDefault && this.byId.has(r.id));
    return this.view(rec?.id ?? [...this.byId.keys()][0]!);
  }
  list(): ProjectView[] {
    return [...this.byId.keys()].map((id) => this.view(id));
  }

  private view(id: string): ProjectView {
    const p = this.byId.get(id)!;
    const r = this.store.byId(id);
    return {
      name: p.name,
      id,
      displayName: r?.displayName ?? null,
      isDefault: r?.isDefault ?? false,
      isSandbox: r?.isSandbox ?? false,
      readOnly: r?.readOnly ?? false,
      configured: true,
      registered: true,
      status: p.unavailable ? 'stopped' : 'active',
      reason: p.unavailable ?? null,
      keyVariable: null,
      keyValid: null,
      verifiedAt: r?.verifiedAt ?? null,
      checkedAt: null,
      settings: r?.settings ?? {},
      settingsProblem: r?.settingsProblem ?? null,
      keySource: null,
      keyHint: null,
      keyConflict: null,
      draining: false,
      archivedAt: r?.archivedAt ?? null,
    };
  }

  /** Test seam: takes a project out of service (or back, with `null`), as a failed key check would. */
  setUnavailable(projectId: string, reason: string | null): void {
    const p = this.byId.get(projectId);
    if (!p) return;
    this.byId.set(projectId, { ...p, ...(reason ? { unavailable: reason } : { unavailable: undefined }) });
    for (const l of [...this.listeners]) l(this.view(projectId));
  }

  /** Test seam: the per-project read-only flag. */
  setReadOnly(projectId: string, readOnly: boolean): void {
    this.store.setReadOnly(projectId, readOnly);
    if (!this.byId.has(projectId)) return;
    for (const l of [...this.listeners]) l(this.view(projectId));
  }
}
