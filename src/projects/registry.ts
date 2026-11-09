/**
 * The project registry (v2 A1, docs/projects.md): which LegendKeeper projects this bridge serves, each with its OWN
 * governor (its key's tiers and its project tier), and whether each may be served right now.
 *
 * Start-up check, per configured project (`verifyAll`): its key must authenticate, and the project the key belongs to
 * (`listProjects`, which a project key answers with exactly its own project) must be the one stored under that name
 * (and, in the single-project form, the one LK_PROJECT_ID names). A new name is registered with the id its key proves.
 * - A refused key, a key of another project, or a LegendKeeper project already registered under another name STOPS
 *   that project: it is not served, the reason shows on the dashboard and in the log. The others keep working.
 * - When LegendKeeper cannot be asked (unreachable, 5xx, budget), the project is `unverified` and checked again with a
 *   growing delay (15 s up to 10 minutes). It is not served meanwhile.
 * Keys are never logged, stored or shown: only the name of the variable that holds one.
 */
import type { Config, ProjectKeyConfig } from '../config/index.js';
import { lkSettingsFor } from '../config/lk.js';
import type { Db } from '../db/open.js';
import { callOp } from '../jobs/lk-call.js';
import { BridgeLkError, BudgetWaitError } from '../lk/errors.js';
import { createLkClient, type LkClient } from '../lk/client.js';
import { systemClock, type Clock, type TimerHandle } from '../lk/governor/clock.js';
import type { Transport } from '../lk/governor/governor.js';
import { createSqliteCounterStore } from '../lk/governor/persist.js';
import { requireOperation } from '../lk/registry.js';
import type { SelectableProjects } from './selection.js';
import { ProjectStore } from './store.js';
import type { ProjectRecord, ProjectStatus, ProjectView } from './types.js';

export interface RegistryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const quiet: RegistryLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** What the job engine, the tools and the dashboard need from the registry. `ProjectRegistry` implements it. */
export interface ProjectsRuntime {
  /** The LK client of an ACTIVE project; undefined when the project is unknown or not served now. */
  client(projectId: string): LkClient | undefined;
  /** The client of a configured project whatever its status (budget views); undefined when it has none. */
  anyClient(projectId: string): LkClient | undefined;
  /** Whether `projectId` is a project stored in this database. */
  known(projectId: string): boolean;
  /** The project's name, for messages (its id when unknown). */
  nameOf(projectId: string): string;
  /** The per-project read-only flag (true overrides the bridge-wide flag for this project). */
  readOnly(projectId: string): boolean;
  /** Why the project is not served now, or null when it is. */
  unavailableReason(projectId: string): string | null;
  /** Ids of the projects served now, in configuration order. */
  activeIds(): string[];
  /** Calls `cb` whenever a project's status or flags change. Returns an unsubscribe function. */
  onChange(cb: (view: ProjectView) => void): () => void;
}

export interface CreateProjectRegistryOptions {
  readonly db: Db;
  readonly config: Config;
  readonly clock?: Clock;
  /** Network transport under every governor (tests point it at a mock LegendKeeper). */
  readonly transport?: Transport;
  readonly random?: () => number;
  readonly log?: RegistryLogger;
  /** Keep each governor's counts across restarts (default true; table governor_counters, one row per project). */
  readonly persistCounters?: boolean;
  /** First and largest delay before an `unverified` project is checked again. */
  readonly retryMs?: { readonly first: number; readonly max: number };
}

interface Entry {
  readonly config: ProjectKeyConfig;
  id: string | null;
  client: LkClient | null;
  status: ProjectStatus;
  reason: string | null;
  keyValid: boolean | null;
  checkedAt: number | null;
  retryTimer: TimerHandle | null;
  retryDelay: number;
  checking: Promise<void> | null;
}

export class ProjectRegistry implements ProjectsRuntime, SelectableProjects {
  readonly store: ProjectStore;
  readonly defaultName: string;
  private readonly entries = new Map<string, Entry>();
  private readonly clock: Clock;
  private readonly log: RegistryLogger;
  private readonly listeners = new Set<(v: ProjectView) => void>();
  private records = new Map<string, ProjectRecord>();
  private closed = false;

  constructor(private readonly o: CreateProjectRegistryOptions) {
    this.clock = o.clock ?? systemClock;
    this.log = o.log ?? quiet;
    this.store = new ProjectStore(o.db, () => this.clock.now());
    this.defaultName = o.config.lk.defaultProject;
    this.reload();
    // The default flag follows LK_DEFAULT_PROJECT at once, even before the check (a stored project keeps its row).
    this.store.setDefault(this.defaultName);
    this.reload();
    for (const p of o.config.lk.projects) {
      const stored = this.byName(p.name);
      const entry: Entry = {
        config: p,
        id: stored?.id ?? null,
        client: null,
        status: 'verifying',
        reason: 'The key has not been checked yet.',
        keyValid: null,
        checkedAt: null,
        retryTimer: null,
        retryDelay: o.retryMs?.first ?? 15_000,
        checking: null,
      };
      // A stored project gets its governor at once, so its saved counts are restored before anything is sent.
      if (entry.id !== null) entry.client = this.newClient(p, entry.id);
      this.entries.set(p.name, entry);
    }
  }

  // ============================================================================================ queries

  /** Every project: configured ones in configuration order, then stored ones the env file no longer lists. */
  list(): ProjectView[] {
    const out: ProjectView[] = [];
    for (const e of this.entries.values()) out.push(this.view(e));
    for (const r of this.records.values()) {
      if (!this.entries.has(r.name)) out.push(this.storedOnlyView(r));
    }
    return out;
  }

  /** Configured project names, in configuration order (what an agent may pass as `project`). */
  configuredNames(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * A configured project by name (any case) or by LegendKeeper id, once its id is known. Names win over ids. Undefined
   * for anything else (not configured, or configured but never verified).
   */
  resolve(ref: string): ProjectView | undefined {
    const name = ref.trim().toLowerCase();
    const byName = this.entries.get(name);
    if (byName) return byName.id !== null ? this.view(byName) : undefined;
    for (const e of this.entries.values()) if (e.id !== null && e.id === ref.trim()) return this.view(e);
    return undefined;
  }

  /** A configured project by name, even before its id is known (dashboard). */
  byConfiguredName(name: string): ProjectView | undefined {
    const e = this.entries.get(name.trim().toLowerCase());
    return e ? this.view(e) : undefined;
  }

  /** Any project this bridge knows (configured or only stored), by name or id. */
  find(ref: string): ProjectView | undefined {
    return (
      this.resolve(ref) ??
      this.byConfiguredName(ref) ??
      this.list().find((p) => p.name === ref.trim().toLowerCase() || p.id === ref.trim())
    );
  }

  /** The default project (LK_DEFAULT_PROJECT). */
  defaultProject(): ProjectView {
    return this.view(this.entries.get(this.defaultName)!);
  }

  client(projectId: string): LkClient | undefined {
    const e = this.entryById(projectId);
    return e && e.status === 'active' && e.client ? e.client : undefined;
  }

  anyClient(projectId: string): LkClient | undefined {
    return this.entryById(projectId)?.client ?? undefined;
  }

  known(projectId: string): boolean {
    return this.records.has(projectId);
  }

  nameOf(projectId: string): string {
    return this.records.get(projectId)?.name ?? projectId;
  }

  readOnly(projectId: string): boolean {
    return this.records.get(projectId)?.readOnly === true;
  }

  unavailableReason(projectId: string): string | null {
    const e = this.entryById(projectId);
    if (!e) {
      return this.records.has(projectId)
        ? `project "${this.nameOf(projectId)}" is not configured in the env file, so it is not served`
        : `there is no project with id ${projectId}`;
    }
    if (e.status === 'active') return null;
    return `project "${e.config.name}" is not available (${e.status}): ${e.reason ?? 'unknown reason'}`;
  }

  activeIds(): string[] {
    return [...this.entries.values()].filter((e) => e.status === 'active' && e.id).map((e) => e.id!);
  }

  /** Every configured project that has a governor, with its client (budget views, the budget sampler). */
  clients(): { readonly id: string; readonly name: string; readonly client: LkClient }[] {
    return [...this.entries.values()]
      .filter((e) => e.id !== null && e.client !== null)
      .map((e) => ({ id: e.id!, name: e.config.name, client: e.client! }));
  }

  onChange(cb: (view: ProjectView) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ============================================================================================ owner changes

  /** Sets a project's own read-only flag (owner commands audit it). Returns the new view. */
  setReadOnly(projectId: string, readOnly: boolean): ProjectView | undefined {
    if (!this.store.setReadOnly(projectId, readOnly)) return undefined;
    this.reload();
    const v = this.viewById(projectId);
    if (v) this.emit(v);
    return v;
  }

  // ============================================================================================ checks

  /** Checks every configured project's key (in parallel). Never throws: a failure stops only that project. */
  async verifyAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((n) => this.verify(n)));
  }

  /** Checks one configured project's key now. Resolves with its view afterwards. */
  async verify(name: string): Promise<ProjectView | undefined> {
    const e = this.entries.get(name);
    if (!e || this.closed) return e ? this.view(e) : undefined;
    if (e.retryTimer) this.clock.clearTimeout(e.retryTimer);
    e.retryTimer = null;
    e.checking ??= this.check(e).finally(() => {
      e.checking = null;
    });
    await e.checking;
    return this.view(e);
  }

  private async check(e: Entry): Promise<void> {
    const p = e.config;
    // The project's own governor when its id is known; otherwise a throwaway one, only to ask which project it is.
    const probe = e.client ?? this.newClient(p, '', false);
    let projects: { id?: unknown; name?: unknown }[];
    try {
      const r = (await callOp(
        probe,
        requireOperation('listProjects'),
        {},
        {
          priority: 'P0',
          requestIdPrefix: `lkb.verify.${p.name}.${this.clock.now().toString(36)}`,
        },
      )) as { data?: { id?: unknown; name?: unknown }[] } | undefined;
      projects = Array.isArray(r?.data) ? r.data : [];
    } catch (err) {
      if (probe !== e.client) probe.governor.close();
      this.failed(e, err);
      return;
    }
    if (probe !== e.client) probe.governor.close();
    e.checkedAt = this.clock.now();
    e.keyValid = true;

    if (projects.length !== 1 || typeof projects[0]?.id !== 'string' || projects[0].id === '') {
      return this.stop(
        e,
        `the key sees ${projects.length} LegendKeeper projects; a project key sees exactly one, its own`,
      );
    }
    const id = projects[0].id;
    const displayName = typeof projects[0].name === 'string' ? projects[0].name.slice(0, 200) : null;
    if (p.expectedProjectId !== null && p.expectedProjectId !== id) {
      return this.stop(
        e,
        `${p.keyVariable} belongs to LegendKeeper project ${id}, not ${p.expectedProjectId} (LK_PROJECT_ID)`,
      );
    }
    const stored = this.byName(p.name);
    if (stored && stored.id !== id) {
      return this.stop(
        e,
        `${p.keyVariable} belongs to LegendKeeper project ${id}, but project "${p.name}" is LegendKeeper project ` +
          `${stored.id} in this bridge's database. Put that project's key in ${p.keyVariable}`,
      );
    }
    const other = this.records.get(id);
    if (!stored && other && other.name !== p.name) {
      return this.stop(
        e,
        `${p.keyVariable} belongs to LegendKeeper project ${id}, which this bridge already serves as "${other.name}"`,
      );
    }
    for (const x of this.entries.values()) {
      if (x !== e && x.id === id && x.status !== 'stopped') {
        return this.stop(
          e,
          `${p.keyVariable} belongs to the same LegendKeeper project as "${x.config.name}" (${id}); a project can be ` +
            'registered once',
        );
      }
    }

    const now = this.clock.now();
    if (stored) this.store.markVerified(id, displayName, now);
    else this.store.insert({ id, name: p.name, displayName, verifiedAt: now });
    if (p.name === this.defaultName) this.store.setDefault(p.name);
    this.reload();
    if (e.id === null || e.client === null) {
      e.id = id;
      e.client = this.newClient(p, id);
    }
    e.status = 'active';
    e.reason = null;
    e.retryDelay = this.o.retryMs?.first ?? 15_000;
    this.log.info({ project: p.name, lkProjectId: id }, 'project verified');
    this.emit(this.view(e));
  }

  private failed(e: Entry, err: unknown): void {
    const lk = err instanceof BridgeLkError ? err : undefined;
    e.checkedAt = this.clock.now();
    const status = lk?.status;
    if (status === 401 || status === 403) {
      e.keyValid = false;
      return this.stop(
        e,
        `LegendKeeper refused ${e.config.keyVariable} (${status} ${lk?.code ?? ''})`.trim(),
      );
    }
    if (status === 402) {
      e.keyValid = true;
      return this.stop(e, 'LegendKeeper says the project owner needs a paid plan (402)');
    }
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return this.stop(e, `LegendKeeper answered the key check with ${status} ${lk?.code ?? ''}`.trim());
    }
    // Unreachable, timed out, 5xx or out of budget: try again later; not served meanwhile.
    const why =
      err instanceof BudgetWaitError
        ? 'the request budget is exhausted for now'
        : typeof status === 'number'
          ? `LegendKeeper answered ${status}`
          : 'LegendKeeper could not be reached';
    e.status = 'unverified';
    e.reason = `The key could not be checked: ${why}. Checking again in ${Math.round(e.retryDelay / 1000)} s.`;
    this.log.warn({ project: e.config.name, reason: e.reason }, 'project key could not be checked');
    this.emit(this.view(e));
    if (!this.closed) {
      const delay = e.retryDelay;
      e.retryDelay = Math.min(delay * 2, this.o.retryMs?.max ?? 600_000);
      e.retryTimer = this.clock.setTimeout(() => {
        e.retryTimer = null;
        void this.verify(e.config.name);
      }, delay);
    }
  }

  private stop(e: Entry, reason: string): void {
    e.status = 'stopped';
    e.reason = `${reason}. Project "${e.config.name}" is not served; the other projects are unaffected.`;
    this.log.error({ project: e.config.name, reason: e.reason }, 'project stopped');
    this.emit(this.view(e));
  }

  /** Stops every retry timer and closes every governor (saving its counts). */
  close(): void {
    this.closed = true;
    for (const e of this.entries.values()) {
      if (e.retryTimer) this.clock.clearTimeout(e.retryTimer);
      e.retryTimer = null;
      e.client?.governor.close();
    }
  }

  // ============================================================================================ internals

  private newClient(p: ProjectKeyConfig, projectId: string, persist = true): LkClient {
    return createLkClient({
      ...lkSettingsFor(this.o.config, { apiKey: p.apiKey, projectId }),
      ...(this.o.clock ? { clock: this.o.clock } : {}),
      ...(this.o.transport ? { transport: this.o.transport } : {}),
      ...(this.o.random ? { random: this.o.random } : {}),
      ...(persist && projectId !== '' && this.o.persistCounters !== false
        ? {
            persistence: {
              store: createSqliteCounterStore(this.o.db, projectId),
              warn: (message: string, err: unknown) => this.log.warn({ err, project: p.name }, message),
            },
          }
        : {}),
    });
  }

  private reload(): void {
    this.records = new Map(this.store.list().map((r) => [r.id, r]));
  }

  private byName(name: string): ProjectRecord | undefined {
    for (const r of this.records.values()) if (r.name === name) return r;
    return undefined;
  }

  private entryById(projectId: string): Entry | undefined {
    for (const e of this.entries.values()) if (e.id === projectId) return e;
    return undefined;
  }

  private viewById(projectId: string): ProjectView | undefined {
    const e = this.entryById(projectId);
    if (e) return this.view(e);
    const r = this.records.get(projectId);
    return r ? this.storedOnlyView(r) : undefined;
  }

  private view(e: Entry): ProjectView {
    const r = e.id !== null ? this.records.get(e.id) : undefined;
    return {
      name: e.config.name,
      id: e.id,
      displayName: r?.displayName ?? null,
      isDefault: e.config.name === this.defaultName,
      isSandbox: r?.isSandbox ?? false,
      readOnly: r?.readOnly ?? false,
      configured: true,
      registered: r !== undefined,
      status: e.status,
      reason: e.reason,
      keyVariable: e.config.keyVariable,
      keyValid: e.keyValid,
      verifiedAt: r?.verifiedAt ?? null,
      checkedAt: e.checkedAt,
      settings: r?.settings ?? {},
      settingsProblem: r?.settingsProblem ?? null,
    };
  }

  private storedOnlyView(r: ProjectRecord): ProjectView {
    return {
      name: r.name,
      id: r.id,
      displayName: r.displayName,
      isDefault: false,
      isSandbox: r.isSandbox,
      readOnly: r.readOnly,
      configured: false,
      registered: true,
      status: 'not_configured',
      reason: 'Not listed in the env file, so it is not served. Its stored data is kept.',
      keyVariable: null,
      keyValid: null,
      verifiedAt: r.verifiedAt,
      checkedAt: null,
      settings: r.settings,
      settingsProblem: r.settingsProblem,
    };
  }

  private emit(v: ProjectView): void {
    for (const l of [...this.listeners]) {
      try {
        l(v);
      } catch (err) {
        this.log.warn({ err }, 'a project change listener failed');
      }
    }
  }
}

export function createProjectRegistry(o: CreateProjectRegistryOptions): ProjectRegistry {
  return new ProjectRegistry(o);
}
